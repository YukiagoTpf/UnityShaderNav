import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectRepositorySnapshot,
  validateKnowledgeSnapshot,
} from './check-public-knowledge.mjs';
import { npmInvocation } from './rebuild-tree-sitter-hlsl.mjs';

test('accepts exact local links, reference links, parentheses, ADR identity, and provenance', () => {
  const files = validSnapshot();
  files.set('README.md', bytes([
    '[Docs](docs/README.md)',
    '[Parentheses](docs/a_(b).md "title")',
    '[Guide][guide]',
    '',
    '[guide]: docs/README.md',
    'See ADR-0001.',
  ].join('\n')));
  files.set('docs/a_(b).md', bytes('# Parentheses\n'));

  const result = validateKnowledgeSnapshot(files);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.stats.localLinks, 4);
  assert.equal(result.stats.adrs, 1);
});

test('accepts heading fragments, duplicate slugs, and explicit HTML anchors', () => {
  const files = validSnapshot();
  files.set('README.md', bytes([
    '# Local Heading',
    '# Local Heading',
    '# 方法一：安装',
    '# 四值保守逻辑（推荐）',
    '# 四值保守逻辑（推荐）',
    '<a id="explicit-anchor"></a>',
    '[local](#local-heading)',
    '[duplicate](#local-heading-1)',
    '[unicode](#方法一安装)',
    '[unicode punctuation](#四值保守逻辑推荐)',
    '[unicode duplicate](#四值保守逻辑推荐-1)',
    '[explicit](#explicit-anchor)',
    '[cross](docs/guide.md#target-heading)',
  ].join('\n')));
  files.set('docs/guide.md', bytes('## Target *Heading*\n'));

  const result = validateKnowledgeSnapshot(files);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.stats.localLinks, 8);
});

test('rejects missing same-file and cross-file Markdown anchors', () => {
  const files = validSnapshot();
  files.set('README.md', bytes([
    '# Existing',
    '[local](#missing)',
    '[cross](docs/guide.md#missing)',
  ].join('\n')));
  files.set('docs/guide.md', bytes('# Existing\n'));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert.equal(diagnostics.filter((item) => item.rule === 'local-anchor').length, 2);
});

test('validates local href and src targets in raw HTML', () => {
  const files = validSnapshot();
  files.set('README.md', bytes([
    '<a href="missing.md">missing</a>',
    '<img src="missing.png" alt="missing">',
    '<!-- <a href="ignored.md">comment</a> -->',
    '<script>const example = \'<a href="ignored-script.md">\';</script>',
  ].join('\n')));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert.equal(diagnostics.filter((item) => item.rule === 'local-link').length, 2);
});

test('rejects missing case-sensitive links and every repository escape form', () => {
  const files = validSnapshot();
  const drivePath = ['C:', 'Users', 'alice', 'outside.md'].join('\\');
  const uncPath = `\\\\${['server', 'share', 'outside.md'].join('\\')}`;
  files.set('README.md', bytes([
    '[case](docs/Guide.md)',
    '[parent](../outside.md)',
    '[root](/outside.md)',
    `[drive](${drivePath})`,
    `[unc](${uncPath})`,
    '[file](file:///outside.md)',
    '[encoded-hash](docs/%23definitely-missing.md)',
    '[encoded-query](docs/%3Fdefinitely-missing.md)',
  ].join('\n')));
  files.set('docs/guide.md', bytes('# Guide\n'));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert.equal(diagnostics.filter((item) => item.rule === 'local-link').length, 3);
  assert.equal(
    diagnostics.filter((item) => item.rule === 'local-link-outside').length,
    5,
  );
});

test('rejects unresolved reference definitions but ignores code spans and mixed fences', () => {
  const files = validSnapshot();
  const inlineAdr = ['ADR', '9998'].join('-');
  const fencedAdr = ['ADR', '9999'].join('-');
  files.set('README.md', bytes([
    `\`[inline][missing-inline] ${inlineAdr}\``,
    '```text',
    '[fenced][missing-fenced]',
    '~~~',
    fencedAdr,
    '```',
    '\\[literal][missing-escaped]',
    '[broken][missing]',
  ].join('\n')));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  const missingReferences = diagnostics.filter((item) => (
    item.rule === 'local-link' && item.message.startsWith('missing reference definition')
  ));
  assert.equal(missingReferences.length, 1);
  assert.match(missingReferences[0].message, /missing/);
  assert.equal(diagnostics.filter((item) => item.rule === 'adr-reference').length, 0);
});

test('does not treat an escaped backtick as the start of an inline code span', () => {
  const files = validSnapshot();
  const missingAdr = ['ADR', '9999'].join('-');
  const escapedBacktick = `\\${'`'}`;
  files.set('README.md', bytes(`${escapedBacktick} ${missingAdr} [x][missing] \``));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert.equal(diagnostics.filter((item) => item.rule === 'local-link').length, 1);
  assert.equal(diagnostics.filter((item) => item.rule === 'adr-reference').length, 1);
});

test('rejects unsafe Markdown schemes while allowing public web links', () => {
  const files = validSnapshot();
  files.set('README.md', bytes([
    '[web](https://example.com/docs)',
    '[script](javascript:alert)',
    '[legacy](vbscript:alert)',
    '[inline](data:text/plain,content)',
  ].join('\n')));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert.equal(diagnostics.filter((item) => item.rule === 'unsafe-link').length, 3);
});

test('rejects missing and duplicate ADR identities', () => {
  const missing = validSnapshot();
  missing.set('README.md', bytes('See ADR-0002.'));
  assert(validateKnowledgeSnapshot(missing).diagnostics.some((item) => item.rule === 'adr-reference'));

  const duplicate = validSnapshot();
  duplicate.set(fixtureAdrPath('duplicate'), bytes('# Duplicate\n'));
  assert(validateKnowledgeSnapshot(duplicate).diagnostics.some((item) => item.rule === 'duplicate-adr'));
});

test('validates ADR identities and exact paths in non-Markdown public source', () => {
  const files = validSnapshot();
  const missingAdr = ['ADR', '9999'].join('-');
  const missingPath = ['docs', 'adr', '0001-missing.md'].join('/');
  files.set('source.ts', bytes(`// ${missingAdr}\n// ${missingPath}\n`));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert.equal(diagnostics.filter((item) => item.rule === 'adr-reference').length, 1);
  assert.equal(diagnostics.filter((item) => item.rule === 'adr-path').length, 1);
});

test('rejects historical execution paths and slash variants in authored text', () => {
  const files = validSnapshot();
  const plans = ['docs', 'plans'].join('/');
  const handoffs = ['docs', 'handoffs'].join('\\');
  const superpowers = ['docs', 'superpowers'].join('/');
  files.set(`${plans}/old.md`, bytes('# Old plan\n'));
  files.set('notes.txt', bytes([
    `Remove ${plans}`,
    `Remove ${handoffs}\\old.md`,
    `Remove ${superpowers}/old.md`,
    'Keep https://example.com/productdocs/plans',
  ].join('\n')));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert(diagnostics.some((item) => item.rule === 'historical-path'));
  assert.equal(
    diagnostics.filter((item) => item.rule === 'historical-reference').length,
    3,
  );
});

test('rejects exact personal home roots, descendants, and non-public hosts', () => {
  const files = validSnapshot();
  const privateHost = ['docs', ['larkoffice', 'com'].join('.')].join('.');
  const macHome = ['', 'Users', 'alice'].join('/');
  const linuxProject = ['', 'home', 'alice', 'project'].join('/');
  const windowsHome = ['C:', 'Users', 'alice'].join('\\');
  const windowsProject = ['D:', 'Users', 'alice', 'project'].join('/');
  files.set('notes.txt', bytes([
    macHome,
    linuxProject,
    windowsHome,
    windowsProject,
    `https://${privateHost}/doc`,
    'https://example.com/Users/alice/profile',
  ].join('\n')));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert.equal(diagnostics.filter((item) => item.rule === 'personal-home').length, 4);
  assert(diagnostics.some((item) => item.rule === 'non-public-source'));
});

test('rejects a duplicated Claude policy instead of the canonical import', () => {
  const files = validSnapshot();
  files.set('CLAUDE.md', bytes('# copied mutable policy\n'));
  assert(validateKnowledgeSnapshot(files).diagnostics.some((item) => item.rule === 'agent-entrypoint'));
});

test('rejects tampered grammar and upstream license bytes', () => {
  const files = validSnapshot();
  files.set('server/grammars/tree-sitter-hlsl.wasm', bytes('tampered artifact'));
  files.set('server/grammars/tree-sitter-hlsl.LICENSE', bytes('tampered license'));

  const rules = validateKnowledgeSnapshot(files).diagnostics.map((item) => item.rule);
  assert(rules.includes('grammar-artifact'));
  assert(rules.includes('grammar-license'));
});

test('rejects invalid UTF-8 in public source files instead of treating it as binary', () => {
  const files = validSnapshot();
  files.set('secret.md', Buffer.from([0xff, 0xfe]));

  const diagnostics = validateKnowledgeSnapshot(files).diagnostics;
  assert.equal(diagnostics.filter((item) => item.rule === 'text-encoding').length, 1);
});

test('rejects non-canonical integrity and provenance-controlled output paths', () => {
  const shortIntegrity = validSnapshot();
  mutateProvenance(shortIntegrity, (provenance) => {
    provenance.toolchain.treeSitterCli.integrity = 'sha512-A';
  });
  assert(validateKnowledgeSnapshot(shortIntegrity).diagnostics.some((item) => (
    item.rule === 'grammar-provenance'
  )));

  for (const field of ['artifact', 'license']) {
    const files = validSnapshot();
    mutateProvenance(files, (provenance) => {
      if (field === 'artifact') provenance.artifact.path = '../outside.wasm';
      else provenance.source.licensePath = '../outside.LICENSE';
    });
    assert(validateKnowledgeSnapshot(files).diagnostics.some((item) => (
      item.rule === 'grammar-provenance'
    )));
  }
});

test('rejects dangling symlinks instead of skipping their authored target', {
  skip: process.platform === 'win32',
}, () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'usn-knowledge-test-'));
  try {
    execFileSync('git', ['init', '--quiet', repositoryRoot]);
    const danglingTarget = ['', 'Users', 'alice', 'private-source'].join('/');
    symlinkSync(danglingTarget, join(repositoryRoot, 'external-source'));
    assert.throws(
      () => collectRepositorySnapshot(repositoryRoot),
      /tracked or unignored symlinks are not allowed/,
    );
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('rejects literal backslashes in Git paths instead of collapsing snapshot keys', {
  skip: process.platform === 'win32',
}, () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'usn-knowledge-test-'));
  try {
    execFileSync('git', ['init', '--quiet', repositoryRoot]);
    const nonCanonicalPath = ['notes', 'entry.txt'].join('\\');
    writeFileSync(join(repositoryRoot, nonCanonicalPath), 'content\n');
    assert.throws(
      () => collectRepositorySnapshot(repositoryRoot),
      /Git paths must use canonical forward slashes/,
    );
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('uses an executable npm launcher on POSIX and Windows', () => {
  assert.deepEqual(
    npmInvocation(['view', 'package'], 'linux'),
    { command: 'npm', args: ['view', 'package'] },
  );
  assert.deepEqual(
    npmInvocation(['view', 'package'], 'win32', 'C:\\Windows\\System32\\cmd.exe'),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'view', 'package'],
    },
  );
});

function validSnapshot() {
  const artifact = bytes('deterministic wasm fixture');
  const license = bytes('upstream license fixture\n');
  const provenance = {
    schemaVersion: 1,
    source: {
      repository: 'https://github.com/tree-sitter-grammars/tree-sitter-hlsl.git',
      tag: 'v0.2.0',
      commit: 'a'.repeat(40),
      licensePath: 'server/grammars/tree-sitter-hlsl.LICENSE',
      licenseSha256: sha256(license),
    },
    toolchain: {
      treeSitterCli: {
        version: '0.24.7',
        integrity: `sha512-${Buffer.alloc(64, 0xab).toString('base64')}`,
        registry: 'https://registry.npmjs.org',
      },
      emscripten: {
        image: 'docker.io/emscripten/emsdk',
        tag: '3.1.64',
        digest: `sha256:${'b'.repeat(64)}`,
        platform: 'linux/amd64',
      },
    },
    artifact: {
      path: 'server/grammars/tree-sitter-hlsl.wasm',
      size: artifact.length,
      sha256: sha256(artifact),
    },
  };

  return new Map([
    ['AGENTS.md', bytes('# Agent instructions\n')],
    ['CLAUDE.md', bytes('@AGENTS.md\n')],
    ['README.md', bytes('[Docs](docs/README.md) See ADR-0001.\n')],
    ['docs/README.md', bytes('[Decisions](adr/)\n')],
    [fixtureAdrPath('example'), bytes('# Decision\n')],
    ['server/grammars/tree-sitter-hlsl.wasm', artifact],
    ['server/grammars/tree-sitter-hlsl.LICENSE', license],
    ['server/grammars/tree-sitter-hlsl.provenance.json', bytes(`${JSON.stringify(provenance)}\n`)],
  ]);
}

function mutateProvenance(files, mutate) {
  const path = 'server/grammars/tree-sitter-hlsl.provenance.json';
  const provenance = JSON.parse(files.get(path).toString('utf8'));
  mutate(provenance);
  files.set(path, bytes(`${JSON.stringify(provenance)}\n`));
}

function fixtureAdrPath(suffix) {
  return ['docs', 'adr', `0001-${suffix}.md`].join('/');
}

function bytes(value) {
  return Buffer.from(value, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
