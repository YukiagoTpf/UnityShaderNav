import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import MarkdownIt from 'markdown-it';
import {
  parseGrammarProvenance,
  PROVENANCE_PATH,
} from './tree-sitter-hlsl-provenance.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), '..');
const decoder = new TextDecoder('utf-8', { fatal: true });
const markdownParser = new MarkdownIt({ html: true, linkify: false, typographer: false });
markdownParser.validateLink = () => true;

const HISTORICAL_DIRECTORY_PARTS = [
  ['docs', 'plans'],
  ['docs', 'handoffs'],
  ['docs', 'superpowers'],
];
const HISTORICAL_DIRECTORIES = HISTORICAL_DIRECTORY_PARTS.map((parts) => parts.join('/') + '/');
const PRIVATE_HOST_SUFFIXES = [
  ['larkoffice', 'com'].join('.'),
  ['feishu', 'cn'].join('.'),
  ['byted', 'org'].join('.'),
  ['bytedance', 'net'].join('.'),
  ['byteintl', 'net'].join('.'),
];
const POSIX_HOME_PATTERN = /(?<![A-Za-z0-9._:-])\/(?:Users|home)\/[^/\\\s'"`]+/g;
const WINDOWS_HOME_PATTERN = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`]+/g;
const HOST_TOKEN_PATTERN = /\b(?:[a-z0-9-]+\.)+(?:corp|internal)\b/gi;
const BINARY_EXTENSIONS = new Set(['.png', '.wasm', '.vsix']);

export function validateKnowledgeSnapshot(files) {
  const diagnostics = [];
  const paths = new Set(files.keys());
  const textFiles = new Map();
  let markdownFiles = 0;
  let localLinks = 0;

  for (const [path, bytes] of files) {
    const text = decodeText(bytes);
    if (text !== undefined) {
      textFiles.set(path, text);
    } else if (!BINARY_EXTENSIONS.has(posix.extname(path).toLowerCase())) {
      diagnostics.push(diagnostic(path, 1, 1, 'text-encoding', 'public source files must be valid UTF-8 text without NUL bytes'));
    }
    for (const historical of HISTORICAL_DIRECTORIES) {
      if (path === historical.slice(0, -1) || path.startsWith(historical)) {
        diagnostics.push(diagnostic(path, 1, 1, 'historical-path', `remove historical execution path ${path}`));
      }
    }
  }

  const markdownDocuments = new Map();
  for (const [path, text] of textFiles) {
    if (path.toLowerCase().endsWith('.md')) {
      markdownDocuments.set(path, markdownLinks(text));
    }
  }

  for (const [path, text] of textFiles) {
    scanAuthoredText(path, text, diagnostics);
    const parsed = markdownDocuments.get(path);
    if (!parsed) continue;
    markdownFiles += 1;
    for (const missing of parsed.missingReferences) {
      diagnostics.push(atOffset(
        path,
        text,
        missing.offset,
        'local-link',
        `missing reference definition ${missing.label}`,
      ));
    }
    for (const link of parsed.links) {
      localLinks += validateLocalLink(
        path,
        link.target,
        link.offset,
        text,
        paths,
        markdownDocuments,
        diagnostics,
      );
    }
  }

  validateAdrReferences(textFiles, paths, diagnostics);
  validateAgentEntrypoint(textFiles, paths, diagnostics);
  const grammar = validateGrammarProvenance(files, diagnostics);

  diagnostics.sort((a, b) => (
    a.path.localeCompare(b.path)
    || a.line - b.line
    || a.column - b.column
    || a.rule.localeCompare(b.rule)
    || a.message.localeCompare(b.message)
  ));

  return {
    diagnostics,
    stats: {
      markdownFiles,
      localLinks,
      adrs: Array.from(paths).filter((path) => /^docs\/adr\/\d{4}-[^/]+\.md$/.test(path)).length,
      grammarSha256: grammar,
    },
  };
}

export function collectRepositorySnapshot(repositoryRoot = defaultRepositoryRoot) {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const files = new Map();
  for (const rawPath of output.toString('utf8').split('\0')) {
    if (!rawPath) continue;
    if (rawPath.includes('\\')) {
      throw new Error(`${rawPath}:1:1 [repository-path] Git paths must use canonical forward slashes`);
    }
    const path = rawPath;
    const absolute = resolve(repositoryRoot, rawPath);
    let fileStat;
    try {
      fileStat = lstatSync(absolute);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
    if (fileStat.isSymbolicLink()) {
      throw new Error(`${path}:1:1 [symlink] tracked or unignored symlinks are not allowed in the knowledge snapshot`);
    }
    if (!fileStat.isFile()) continue;
    if (files.has(path)) {
      throw new Error(`${path}:1:1 [repository-path] duplicate canonical repository path`);
    }
    files.set(path, readFileSync(absolute));
  }
  return files;
}

function scanAuthoredText(path, text, diagnostics) {
  for (const parts of HISTORICAL_DIRECTORY_PARTS) {
    const label = parts.join('/') + '/';
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_-])${escapeRegExp(parts[0])}[\\\\/]${escapeRegExp(parts[1])}(?=$|[\\\\/]|[^A-Za-z0-9_-])`,
      'gi',
    );
    for (const match of text.matchAll(pattern)) {
      diagnostics.push(atOffset(path, text, match.index ?? 0, 'historical-reference', `remove reference to ${label}`));
    }
  }

  for (const pattern of [POSIX_HOME_PATTERN, WINDOWS_HOME_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      diagnostics.push(atOffset(path, text, match.index ?? 0, 'personal-home', `replace personal home path ${match[0]} with a repository-relative or generic path`));
    }
  }

  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    const pattern = new RegExp(`\\b(?:[a-z0-9-]+\\.)*${escapeRegExp(suffix)}\\b`, 'gi');
    for (const match of text.matchAll(pattern)) {
      diagnostics.push(atOffset(path, text, match.index ?? 0, 'non-public-source', `remove non-public host ${match[0]}`));
    }
  }
  for (const match of text.matchAll(HOST_TOKEN_PATTERN)) {
    diagnostics.push(atOffset(path, text, match.index ?? 0, 'non-public-source', `remove non-public host ${match[0]}`));
  }
}

function validateLocalLink(
  sourcePath,
  rawTarget,
  offset,
  markdown,
  paths,
  markdownDocuments,
  diagnostics,
) {
  const target = rawTarget.startsWith('<') && rawTarget.endsWith('>')
    ? rawTarget.slice(1, -1)
    : rawTarget;
  if (!target) return 0;

  const fragmentIndex = target.indexOf('#');
  const rawFragment = fragmentIndex >= 0 ? target.slice(fragmentIndex + 1) : undefined;
  const rawPath = target.split(/[?#]/, 1)[0];
  if (!rawPath) {
    validateLocalFragment(
      sourcePath,
      sourcePath,
      rawFragment,
      rawTarget,
      offset,
      markdown,
      markdownDocuments,
      diagnostics,
    );
    return rawFragment === undefined ? 0 : 1;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    diagnostics.push(atOffset(sourcePath, markdown, offset, 'local-link', `cannot decode local target ${rawTarget}`));
    return 1;
  }

  if (/^[A-Za-z]:[\\/]/.test(decodedPath) || decodedPath.startsWith('\\') || /^file:/i.test(decodedPath)) {
    diagnostics.push(atOffset(sourcePath, markdown, offset, 'local-link-outside', `local target escapes the repository: ${rawTarget}`));
    return 1;
  }
  if (/^(?:javascript|vbscript|data):/i.test(decodedPath)) {
    diagnostics.push(atOffset(sourcePath, markdown, offset, 'unsafe-link', `unsafe link scheme in ${rawTarget}`));
    return 0;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(decodedPath) || decodedPath.startsWith('//')) return 0;

  const localPath = decodedPath.replaceAll('\\', '/');
  if (localPath.startsWith('/')) {
    diagnostics.push(atOffset(sourcePath, markdown, offset, 'local-link-outside', `local target escapes the repository: ${rawTarget}`));
    return 1;
  }

  const resolvedTarget = posix.normalize(posix.join(posix.dirname(sourcePath), localPath));
  if (resolvedTarget === '..' || resolvedTarget.startsWith('../')) {
    diagnostics.push(atOffset(sourcePath, markdown, offset, 'local-link-outside', `local target escapes the repository: ${rawTarget}`));
    return 1;
  }

  const directoryPrefix = resolvedTarget.endsWith('/') ? resolvedTarget : `${resolvedTarget}/`;
  const exists = paths.has(resolvedTarget)
    || Array.from(paths).some((path) => path.startsWith(directoryPrefix));
  if (!exists) {
    diagnostics.push(atOffset(sourcePath, markdown, offset, 'local-link', `missing exact-case target ${resolvedTarget}`));
  } else {
    validateLocalFragment(
      sourcePath,
      resolvedTarget,
      rawFragment,
      rawTarget,
      offset,
      markdown,
      markdownDocuments,
      diagnostics,
    );
  }
  return 1;
}

function validateLocalFragment(
  sourcePath,
  targetPath,
  rawFragment,
  rawTarget,
  offset,
  markdown,
  markdownDocuments,
  diagnostics,
) {
  if (rawFragment === undefined || rawFragment === '') return;
  let fragment;
  try {
    fragment = decodeURIComponent(rawFragment);
  } catch {
    diagnostics.push(atOffset(sourcePath, markdown, offset, 'local-anchor', `cannot decode anchor in ${rawTarget}`));
    return;
  }
  const targetDocument = markdownDocuments.get(targetPath);
  if (targetDocument && !targetDocument.anchors.has(fragment)) {
    diagnostics.push(atOffset(sourcePath, markdown, offset, 'local-anchor', `missing anchor #${fragment} in ${targetPath}`));
  }
}

function validateAdrReferences(textFiles, paths, diagnostics) {
  const adrPaths = new Map();
  for (const path of paths) {
    const match = /^docs\/adr\/(\d{4})-[^/]+\.md$/.exec(path);
    if (!match) continue;
    const existing = adrPaths.get(match[1]) ?? [];
    existing.push(path);
    adrPaths.set(match[1], existing);
  }

  for (const [number, matches] of adrPaths) {
    if (matches.length > 1) {
      for (const path of matches) {
        diagnostics.push(diagnostic(path, 1, 1, 'duplicate-adr', `ADR-${number} has ${matches.length} files`));
      }
    }
  }

  for (const [path, text] of textFiles) {
    const authoredText = path.toLowerCase().endsWith('.md')
      ? markdownWithoutCode(text)
      : text;
    for (const match of authoredText.matchAll(/\bADR-(\d{4})\b/g)) {
      const matches = adrPaths.get(match[1]) ?? [];
      if (matches.length !== 1) {
        diagnostics.push(atOffset(path, authoredText, match.index ?? 0, 'adr-reference', `ADR-${match[1]} resolves to ${matches.length} files`));
      }
    }
    for (const match of authoredText.matchAll(/(?<![A-Za-z0-9_.-])(docs[\\/]adr[\\/]\d{4}-[A-Za-z0-9._-]+\.md)\b/g)) {
      const adrPath = match[1].replaceAll('\\', '/');
      if (!paths.has(adrPath)) {
        diagnostics.push(atOffset(path, authoredText, match.index ?? 0, 'adr-path', `missing exact ADR path ${adrPath}`));
      }
    }
  }
}

function validateAgentEntrypoint(textFiles, paths, diagnostics) {
  const claude = textFiles.get('CLAUDE.md');
  if (claude === undefined || claude.trim() !== '@AGENTS.md') {
    diagnostics.push(diagnostic('CLAUDE.md', 1, 1, 'agent-entrypoint', 'CLAUDE.md must contain only @AGENTS.md'));
  }
  if (!paths.has('AGENTS.md')) {
    diagnostics.push(diagnostic('CLAUDE.md', 1, 1, 'agent-entrypoint', 'CLAUDE.md import target AGENTS.md is missing'));
  }
}

function validateGrammarProvenance(files, diagnostics) {
  const bytes = files.get(PROVENANCE_PATH);
  if (!bytes) {
    diagnostics.push(diagnostic(PROVENANCE_PATH, 1, 1, 'grammar-provenance', 'provenance manifest is missing'));
    return undefined;
  }

  let provenance;
  try {
    provenance = parseGrammarProvenance(decoder.decode(bytes));
  } catch (error) {
    diagnostics.push(diagnostic(
      PROVENANCE_PATH,
      1,
      1,
      'grammar-provenance',
      error instanceof Error ? error.message : String(error),
    ));
    return undefined;
  }

  verifyArtifact(
    files,
    provenance.artifact.path,
    provenance.artifact.size,
    provenance.artifact.sha256,
    'grammar-artifact',
    diagnostics,
  );
  verifyArtifact(
    files,
    provenance.source.licensePath,
    undefined,
    provenance.source.licenseSha256,
    'grammar-license',
    diagnostics,
  );
  return provenance.artifact.sha256;
}

function verifyArtifact(files, path, expectedSize, expectedHash, rule, diagnostics) {
  const bytes = files.get(path);
  if (!bytes) {
    diagnostics.push(diagnostic(PROVENANCE_PATH, 1, 1, rule, `missing ${path}`));
    return;
  }
  if (expectedSize !== undefined && bytes.length !== expectedSize) {
    diagnostics.push(diagnostic(path, 1, 1, rule, `expected ${expectedSize} bytes, received ${bytes.length}`));
  }
  const actualHash = sha256(bytes);
  if (actualHash !== expectedHash) {
    diagnostics.push(diagnostic(path, 1, 1, rule, `expected sha256 ${expectedHash}, received ${actualHash}`));
  }
}

function markdownLinks(markdown) {
  const environment = {};
  const blockTokens = markdownParser.parse(markdown, environment);
  const links = [];
  const anchors = new Set();
  const headingSlugger = new GithubSlugger();
  const lineOffsets = markdownLineOffsets(markdown);

  for (let tokenIndex = 0; tokenIndex < blockTokens.length; tokenIndex += 1) {
    const blockToken = blockTokens[tokenIndex];
    const offset = lineOffsets[blockToken.map?.[0] ?? 0] ?? 0;

    if (blockToken.type === 'heading_open') {
      const inline = blockTokens[tokenIndex + 1];
      if (inline?.type === 'inline' && inline.children) {
        const slug = headingSlugger.slug(visibleInlineText(inline.children));
        if (slug) {
          anchors.add(slug);
        }
      }
    }

    if (blockToken.type === 'html_block') {
      collectHtmlMetadata(blockToken.content, offset, links, anchors);
      continue;
    }
    if (blockToken.type !== 'inline' || !blockToken.children) continue;
    for (const child of blockToken.children) {
      if (child.type === 'link_open') {
        const target = child.attrGet('href');
        if (target !== null) links.push({ target, offset });
      } else if (child.type === 'image') {
        const target = child.attrGet('src');
        if (target !== null) links.push({ target, offset });
      } else if (child.type === 'html_inline') {
        collectHtmlMetadata(child.content, offset, links, anchors);
      }
    }
  }

  const missingReferences = [];
  const authoredMarkdown = markdownWithoutCode(markdown, blockTokens);
  const definitions = environment.references ?? {};
  const referenceLink = /!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  for (const match of authoredMarkdown.matchAll(referenceLink)) {
    if (isEscaped(authoredMarkdown, match.index ?? 0)) continue;
    const rawLabel = match[2] || match[1];
    const label = markdownParser.utils.normalizeReference(rawLabel);
    if (!Object.hasOwn(definitions, label)) {
      missingReferences.push({
        label: JSON.stringify(rawLabel),
        offset: match.index ?? 0,
      });
    }
  }

  return { links, missingReferences, anchors };
}

function collectHtmlMetadata(html, offset, links, anchors) {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<(?:script|style)\b[^>]*>)[\s\S]*?(<\/(?:script|style)\s*>)/gi, '$1$2');
  const startTag = /<[A-Za-z][^>]*>/g;
  const attribute = /(?:^|[\s<])(href|src|id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const tag of markup.matchAll(startTag)) {
    for (const match of tag[0].matchAll(attribute)) {
      const name = match[1].toLowerCase();
      const value = markdownParser.utils.unescapeAll(match[2] ?? match[3] ?? match[4] ?? '');
      if (name === 'href' || name === 'src') links.push({ target: value, offset });
      else if (value) anchors.add(value);
    }
  }
}

function visibleInlineText(children) {
  let text = '';
  for (const child of children) {
    if (child.type === 'text' || child.type === 'code_inline' || child.type === 'image') {
      text += child.content;
    } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
      text += ' ';
    } else if (child.type === 'html_inline') {
      text += child.content.replace(/<[^>]*>/g, '');
    }
  }
  return text;
}

function isEscaped(text, offset) {
  let backslashes = 0;
  for (let index = offset - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function markdownWithoutCode(markdown, tokens = markdownParser.parse(markdown, {})) {
  const characters = markdown.split('');
  const lineOffsets = markdownLineOffsets(markdown);
  for (const token of tokens) {
    if ((token.type !== 'fence' && token.type !== 'code_block') || !token.map) continue;
    const start = lineOffsets[token.map[0]] ?? markdown.length;
    const end = lineOffsets[token.map[1]] ?? markdown.length;
    maskRange(characters, start, end);
  }

  let cursor = 0;
  while (cursor < characters.length) {
    if (characters[cursor] !== '`' || isEscaped(characters, cursor)) {
      cursor += 1;
      continue;
    }
    const openingStart = cursor;
    while (characters[cursor] === '`') cursor += 1;
    const delimiterLength = cursor - openingStart;
    let closingStart = cursor;
    while (closingStart < characters.length) {
      if (characters[closingStart] !== '`') {
        closingStart += 1;
        continue;
      }
      let closingEnd = closingStart;
      while (characters[closingEnd] === '`') closingEnd += 1;
      if (closingEnd - closingStart === delimiterLength) {
        maskRange(characters, openingStart, closingEnd);
        cursor = closingEnd;
        break;
      }
      closingStart = closingEnd;
    }
    if (closingStart >= characters.length) cursor = openingStart + delimiterLength;
  }
  return characters.join('');
}

function markdownLineOffsets(markdown) {
  const offsets = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
  }
}

function decodeText(bytes) {
  if (bytes.includes(0)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function atOffset(path, text, offset, rule, message) {
  const prefix = text.slice(0, offset);
  const line = prefix.split('\n').length;
  const lastNewline = prefix.lastIndexOf('\n');
  return diagnostic(path, line, offset - lastNewline, rule, message);
}

function diagnostic(path, line, column, rule, message) {
  return { path, line, column, rule, message };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatDiagnostic(item) {
  return `${item.path}:${item.line}:${item.column} [${item.rule}] ${item.message}`;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = validateKnowledgeSnapshot(collectRepositorySnapshot());
  if (result.diagnostics.length > 0) {
    for (const item of result.diagnostics) console.error(formatDiagnostic(item));
    process.exitCode = 1;
  } else {
    console.log(
      `[knowledge] ${result.stats.markdownFiles} Markdown files; ${result.stats.localLinks} local links; `
      + `${result.stats.adrs} ADRs; grammar sha256 ${result.stats.grammarSha256}`,
    );
  }
}
