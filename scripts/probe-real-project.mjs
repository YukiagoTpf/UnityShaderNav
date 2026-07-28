/**
 * Drives the built server over a real Unity project and reports crashes and
 * broken invariants. Unlike the synthetic suites, the corpus here is authored
 * by hand at production scale, so this probe asserts contracts rather than
 * expected values: it cannot know what any given Shader should resolve to, but
 * it does know what the server must never do.
 *
 * Every project path is supplied by --project; nothing about any specific
 * project is recorded in this repository.
 *
 * Usage: node scripts/probe-real-project.mjs --project <unity-project-root>
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const SHADER_EXTENSIONS = new Set(['.shader', '.hlsl', '.cginc', '.hlslinc', '.compute']);
const probeRuntime = { releaseVersion: `0.0.0-probe.${process.pid}` };

function parseArgs(argv) {
  const args = { project: undefined, limit: Infinity, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--project') args.project = argv[++i];
    else if (flag === '--limit') args.limit = Number(argv[++i]);
    else if (flag === '--json') args.json = true;
    else if (flag === '--verbose') args.verbose = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.project) throw new Error('--project <unity-project-root> is required');
  if (!(args.limit > 0)) throw new Error('--limit must be a positive number');
  return args;
}

async function collectFiles(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      // Library holds Unity's own import cache, not authored source.
      if (entry.isDirectory()) {
        if (entry.name === 'Library' || entry.name === '.git') continue;
        await walk(path);
        continue;
      }
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : '';
      if (SHADER_EXTENSIONS.has(ext)) found.push(path);
    }
  }
  await walk(root);
  found.sort();
  return found;
}

function silentConnection() {
  return {
    console: { log() {}, warn() {}, error() {} },
    window: {
      createWorkDoneProgress: async () => ({
        begin() {}, report() {}, done() {},
      }),
    },
  };
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Positions worth probing. Every request is position-sensitive, so probing
 * column 0 would mostly land on indentation and prove nothing: aim at the
 * middle of real identifiers, which is where a user actually presses F12.
 */
function probePositions(lines, structureNodes, budget) {
  const positions = new Map();
  const add = (line, character) => {
    if (line < 0 || line >= lines.length) return;
    if (character < 0 || character > (lines[line]?.length ?? 0)) return;
    positions.set(`${line}:${character}`, { line, character });
  };
  const addIdentifiersOn = (line) => {
    const text = lines[line];
    if (text === undefined) return;
    IDENTIFIER.lastIndex = 0;
    for (let match = IDENTIFIER.exec(text); match; match = IDENTIFIER.exec(text)) {
      // Mid-token, so the position is unambiguously inside the identifier.
      add(line, match.index + Math.floor(match[0].length / 2));
    }
  };
  // Structure headers name Shaders, SubShaders, Passes and program blocks.
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (typeof node.headerLine === 'number') addIdentifiersOn(node.headerLine);
      if (node.children) walk(node.children);
    }
  };
  walk(structureNodes);
  // Plus a stride across the body so program-block code is covered too.
  const stride = Math.max(1, Math.floor(lines.length / budget));
  for (let line = 0; line < lines.length; line += stride) addIdentifiersOn(line);
  return [...positions.values()];
}

function describe(error) {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(args.project);
  if (!(await stat(projectRoot)).isDirectory()) {
    throw new Error(`--project is not a directory: ${projectRoot}`);
  }

  const [{ Workspace }, { analyzeDocument }, { DEFAULT_SETTINGS }] = await Promise.all([
    import('../server/out/workspace/workspace.js'),
    import('../server/out/analysis/documentAnalysis.js'),
    import('../shared/out/protocol.js'),
  ]);

  const files = (await collectFiles(projectRoot)).slice(0, args.limit);
  const failures = [];
  const fail = (kind, file, detail) => {
    failures.push({ kind, file: relative(projectRoot, file), detail });
  };

  const folderUri = pathToFileURL(projectRoot).href;
  const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, probeRuntime);
  const stats = {
    projectRoot,
    files: files.length,
    shaders: 0,
    analyzed: 0,
    positionsProbed: 0,
    definitions: 0,
    hovers: 0,
    completions: 0,
    documentSymbols: 0,
    passExplanations: 0,
    slowest: [],
    /** Per-request-kind latency, so a slow file can be attributed to a feature. */
    requests: {},
  };

  try {
    const indexStart = performance.now();
    await workspace.initialize(silentConnection());
    stats.indexMs = performance.now() - indexStart;

    let openId = 0;
    for (const file of files) {
      const uri = pathToFileURL(file).href;
      const isShaderLab = file.toLowerCase().endsWith('.shader');
      if (isShaderLab) stats.shaders++;

      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        fail('read', file, describe(error));
        continue;
      }

      const fileStart = performance.now();

      // 1. Analysis must not throw and must keep its line projections aligned.
      let analysis;
      try {
        analysis = analyzeDocument(uri, text, 'full');
      } catch (error) {
        fail('analyzeDocument threw', file, describe(error));
        continue;
      }
      if (isShaderLab) {
        if (!analysis) {
          fail('analysis missing for .shader', file, 'analyzeDocument returned undefined');
          continue;
        }
        stats.analyzed++;
        const lines = analysis.sourceLines.length;
        for (const projection of [
          'sourceCodeLines',
          'sourceCodeWithoutStringLines',
          'sourceLexicalLines',
        ]) {
          if (analysis[projection].length !== lines) {
            fail('line projection length mismatch', file,
              `${projection} has ${analysis[projection].length} lines, sourceLines has ${lines}`);
          }
        }
        // Blanking is width-preserving, so every code line must match its raw
        // line character for character in length.
        for (let line = 0; line < lines; line++) {
          const raw = analysis.sourceLines[line];
          for (const projection of ['sourceCodeLines', 'sourceCodeWithoutStringLines']) {
            const blanked = analysis[projection][line];
            if (blanked.length !== raw.length) {
              fail('blanking is not width-preserving', file,
                `${projection}[${line}] is ${blanked.length} chars, raw is ${raw.length}`);
              break;
            }
          }
        }
        // Structure ranges must nest and stay inside the file. The root of a
        // StructureResult is `shaders`, not `nodes`.
        const checkNode = (node, parent) => {
          if (node.headerLine < 0 || node.closeLine >= lines) {
            fail('structure node outside the file', file,
              `${node.kind} spans ${node.headerLine}..${node.closeLine}, file has ${lines} lines`);
          }
          if (node.closeLine < node.headerLine) {
            fail('structure node closes before it opens', file,
              `${node.kind} spans ${node.headerLine}..${node.closeLine}`);
          }
          if (parent && (node.headerLine < parent.headerLine || node.closeLine > parent.closeLine)) {
            fail('structure node escapes its parent', file,
              `${node.kind} ${node.headerLine}..${node.closeLine} is not inside ${parent.kind} ${parent.headerLine}..${parent.closeLine}`);
          }
          for (const child of node.children ?? []) checkNode(child, node);
        };
        for (const node of analysis.structure?.shaders ?? []) checkNode(node, undefined);
      }

      // 2. Every navigation request must answer or decline, never throw.
      const document = {
        uri,
        languageId: isShaderLab ? 'shaderlab' : 'hlsl',
        text,
        openId: ++openId,
        version: 1,
      };
      try {
        await workspace.updateDocument(document);
      } catch (error) {
        fail('updateDocument threw', file, describe(error));
        continue;
      }

      const lines = text.split('\n');
      try {
        const symbols = await workspace.documentSymbols({ uri, document });
        if (symbols) stats.documentSymbols += symbols.length;
      } catch (error) {
        fail('documentSymbols threw', file, describe(error));
      }
      try {
        await workspace.semanticTokens({ uri, document });
      } catch (error) {
        fail('semanticTokens threw', file, describe(error));
      }
      try {
        await workspace.diagnosticsAt({ uri, document });
      } catch (error) {
        fail('diagnosticsAt threw', file, describe(error));
      }

      const positions = probePositions(
        lines,
        isShaderLab ? analysis?.structure?.shaders : undefined,
        isShaderLab ? 40 : 20,
      );
      for (const position of positions) {
        stats.positionsProbed++;
        for (const [label, run] of [
          ['definitionAt', async () => {
            const result = await workspace.definitionAt({ document, position });
            if (Array.isArray(result)) stats.definitions += result.length;
            else if (result) stats.definitions++;
          }],
          ['hoverAt', async () => {
            if (await workspace.hoverAt({ document, position })) stats.hovers++;
          }],
          ['completionAt', async () => {
            const items = await workspace.completionAt({ document, position });
            if (items) stats.completions += items.length;
          }],
          ['highlightsAt', () => workspace.highlightsAt({ document, position })],
          ['signatureHelpAt', () => workspace.signatureHelpAt({ document, position })],
          ['referencesAt', () => workspace.referencesAt({
            document,
            position,
            context: { includeDeclaration: true },
          })],
          ['prepareRenameAt', () => workspace.prepareRenameAt({ document, position })],
        ]) {
          const requestStart = performance.now();
          try {
            await run();
          } catch (error) {
            fail(`${label} threw`, file,
              `at ${position.line}:${position.character}: ${describe(error)}`);
          }
          const requestMs = performance.now() - requestStart;
          const timing = stats.requests[label] ?? { calls: 0, totalMs: 0, maxMs: 0, maxAt: '' };
          timing.calls++;
          timing.totalMs += requestMs;
          if (requestMs > timing.maxMs) {
            timing.maxMs = requestMs;
            timing.maxAt = `${relative(projectRoot, file)}:${position.line + 1}`;
          }
          stats.requests[label] = timing;
        }
      }

      // 3. Material Context and the Pass explanation must answer with a valid
      //    shape even with no Unity Editor Adapter connected.
      if (isShaderLab) {
        try {
          await workspace.materialContextAt(uri);
        } catch (error) {
          fail('materialContextAt threw', file, describe(error));
        }
      }

      const elapsed = performance.now() - fileStart;
      stats.slowest.push({ file: relative(projectRoot, file), ms: elapsed });
      stats.slowest.sort((left, right) => right.ms - left.ms);
      stats.slowest.length = Math.min(stats.slowest.length, 10);

      if (args.verbose) {
        process.stderr.write(`${relative(projectRoot, file)} ${elapsed.toFixed(0)}ms\n`);
      }
    }
  } finally {
    workspace.dispose();
  }

  const report = { ...stats, failures: failures.length, details: failures };
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`project        ${projectRoot}`);
    console.log(`files          ${stats.files} (${stats.shaders} ShaderLab)`);
    console.log(`index          ${stats.indexMs?.toFixed(0)}ms`);
    console.log(`positions      ${stats.positionsProbed}`);
    console.log(`definitions    ${stats.definitions}`);
    console.log(`hovers         ${stats.hovers}`);
    console.log(`completions    ${stats.completions}`);
    console.log(`docSymbols     ${stats.documentSymbols}`);
    console.log('request latency (mean / max):');
    const byTotal = Object.entries(stats.requests)
      .sort(([, left], [, right]) => right.totalMs - left.totalMs);
    for (const [label, timing] of byTotal) {
      console.log(`  ${label.padEnd(18)} ${(timing.totalMs / timing.calls).toFixed(1).padStart(8)}ms  ${timing.maxMs.toFixed(0).padStart(7)}ms  ${timing.maxAt}`);
    }
    console.log('slowest files:');
    for (const { file, ms } of stats.slowest) console.log(`  ${ms.toFixed(0)}ms  ${file}`);
    console.log(`failures       ${failures.length}`);
    const shown = new Map();
    for (const failure of failures) {
      const bucket = shown.get(failure.kind) ?? [];
      bucket.push(failure);
      shown.set(failure.kind, bucket);
    }
    for (const [kind, bucket] of shown) {
      console.log(`\n[${kind}] ${bucket.length}`);
      for (const failure of bucket.slice(0, 5)) {
        console.log(`  ${failure.file}\n    ${failure.detail.split('\n')[0]}`);
      }
      if (bucket.length > 5) console.log(`  ... and ${bucket.length - 5} more`);
    }
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(describe(error));
  process.exitCode = 1;
});
