import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { MacroPatternRecognizer } from '../src/macros';
import { indexFile } from '../src/parser/hlsl/fileIndexer';
import { LiveDocumentTreeSession } from '../src/parser/hlsl/liveDocumentTreeSession';
import {
  createHlslParser,
  stabilizeHlslSource,
} from '../src/parser/hlsl/parser';
import type { IndexedDocumentSnapshot } from '../src/workspace/indexedWorkspace';
import { Workspace } from '../src/workspace/workspace';

interface BenchmarkOptions {
  readonly functions: number;
  readonly iterations: number;
  readonly warmup: number;
}

interface Distribution {
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

const connection = {
  console: { log() {}, warn() {}, error() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const uri = 'file:///benchmark/LargeLive.hlsl';
  const first = largeHlslSource(options.functions, 1);
  const second = largeHlslSource(options.functions, 2);
  const recognizer = new MacroPatternRecognizer();

  const correctnessSession = new LiveDocumentTreeSession();
  try {
    await correctnessSession.indexFile(uri, first, recognizer);
    const incremental = await correctnessSession.indexFile(uri, second, recognizer);
    const full = await indexFile(uri, second, recognizer);
    assert.deepStrictEqual(incremental, full, 'incremental FileIndex diverged from full parse');
  } finally {
    correctnessSession.dispose();
  }

  const parseOnly = await benchmarkParseOnly(
    uri,
    first,
    second,
    recognizer,
    options,
  );
  const endToEnd = await benchmarkEndToEnd(first, second, options);

  const result = {
    fixture: {
      functions: options.functions,
      utf16CodeUnits: first.length,
      iterations: options.iterations,
      warmup: options.warmup,
    },
    parseOnly: comparison(parseOnly.full, parseOnly.incremental),
    endToEnd: comparison(endToEnd.full, endToEnd.incremental),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function benchmarkParseOnly(
  uri: string,
  first: string,
  second: string,
  recognizer: MacroPatternRecognizer,
  options: BenchmarkOptions,
): Promise<{ full: Distribution; incremental: Distribution }> {
  const fullParser = await createHlslParser();
  const fullSources = [
    stabilizeHlslSource(first),
    stabilizeHlslSource(second),
  ] as const;
  const fullSamples: number[] = [];
  try {
    for (let index = 0; index < options.warmup + options.iterations; index++) {
      const stabilizedText = fullSources[index % 2];
      const start = performance.now();
      const tree = fullParser.parseStabilized(stabilizedText);
      const elapsed = performance.now() - start;
      tree.delete();
      if (index >= options.warmup) fullSamples.push(elapsed);
    }
  } finally {
    fullParser.delete();
  }

  const incrementalSamples: number[] = [];
  let recording = false;
  const incrementalParser = await createHlslParser();
  const session = new LiveDocumentTreeSession(async () => ({
    parseStabilized(text, oldTree) {
      const start = performance.now();
      const tree = incrementalParser.parseStabilized(text, oldTree);
      if (recording) incrementalSamples.push(performance.now() - start);
      return tree;
    },
    delete: incrementalParser.delete.bind(incrementalParser),
  }));
  try {
    await session.indexFile(uri, first, recognizer);
    let nextText = second;
    for (let index = 0; index < options.warmup; index++) {
      await session.indexFile(uri, nextText, recognizer);
      nextText = nextText === first ? second : first;
    }
    recording = true;
    for (let index = 0; index < options.iterations; index++) {
      await session.indexFile(uri, nextText, recognizer);
      nextText = nextText === first ? second : first;
    }
  } finally {
    session.dispose();
  }

  assert.equal(incrementalSamples.length, options.iterations);
  return { full: distribution(fullSamples), incremental: distribution(incrementalSamples) };
}

async function benchmarkEndToEnd(
  first: string,
  second: string,
  options: BenchmarkOptions,
): Promise<{ full: Distribution; incremental: Distribution }> {
  const root = await mkdtemp(join(tmpdir(), 'usn-live-document-benchmark-'));
  const folderUri = pathToFileURL(root).href;
  const uri = pathToFileURL(join(root, 'LargeLive.hlsl')).href;
  const incremental = new Workspace(folderUri, DEFAULT_SETTINGS, { releaseVersion: null });
  const full = new Workspace(folderUri, DEFAULT_SETTINGS, {
    releaseVersion: null,
    // Deliberately omit the optional live session when invoking the production
    // indexer. This is the pre-incremental full-parse baseline with identical
    // Workspace reconciliation and publication work.
    indexDocument: (indexUri, text, recognizer, analysis) => (
      indexFile(indexUri, text, recognizer, analysis)
    ),
  });
  const incrementalSamples: number[] = [];
  const fullSamples: number[] = [];
  let version = 1;
  let nextText = second;
  let finalText = first;
  try {
    await Promise.all([incremental.initialize(connection), full.initialize(connection)]);
    await Promise.all([
      incremental.updateDocument(snapshot(uri, first, version)),
      full.updateDocument(snapshot(uri, first, version)),
    ]);

    for (let index = 0; index < options.warmup; index++) {
      version++;
      await incremental.updateDocument(snapshot(uri, nextText, version));
      await full.updateDocument(snapshot(uri, nextText, version));
      finalText = nextText;
      nextText = nextText === first ? second : first;
    }

    for (let index = 0; index < options.iterations; index++) {
      version++;
      const document = snapshot(uri, nextText, version);
      if (index % 2 === 0) {
        incrementalSamples.push(await elapsed(() => incremental.updateDocument(document)));
        fullSamples.push(await elapsed(() => full.updateDocument(document)));
      } else {
        fullSamples.push(await elapsed(() => full.updateDocument(document)));
        incrementalSamples.push(await elapsed(() => incremental.updateDocument(document)));
      }
      finalText = nextText;
      nextText = nextText === first ? second : first;
    }

    const expectedName = finalText === first ? 'EditTarget1' : 'EditTarget2';
    assert.equal(incremental.workspaceSymbols(expectedName).length, 1);
    assert.equal(full.workspaceSymbols(expectedName).length, 1);
  } finally {
    incremental.dispose();
    full.dispose();
    await rm(root, { recursive: true, force: true });
  }

  return {
    full: distribution(fullSamples),
    incremental: distribution(incrementalSamples),
  };
}

function largeHlslSource(functionCount: number, variant: number): string {
  const lines = [
    '// UTF-16 fixture 😀',
    '#define BENCH_SCALE 2',
    'struct BenchPayload { float4 position; float2 uv; };',
  ];
  for (let index = 0; index < functionCount; index++) {
    lines.push(
      `float4 BenchFunction${index}(float4 value) { return value * ${index + 1}.0; }`,
    );
    if (index === Math.floor(functionCount / 2)) {
      lines.push(`float4 EditTarget${variant}() { return ${variant}.0; }`);
    }
  }
  return lines.join('\n');
}

function snapshot(uri: string, text: string, version: number): IndexedDocumentSnapshot {
  return { uri, text, version, openId: 1, languageId: 'hlsl' };
}

async function elapsed(operation: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await operation();
  return performance.now() - start;
}

function comparison(full: Distribution, incremental: Distribution) {
  return {
    full,
    incremental,
    p50Speedup: full.p50Ms / incremental.p50Ms,
    p95Speedup: full.p95Ms / incremental.p95Ms,
  };
}

function distribution(samples: readonly number[]): Distribution {
  assert(samples.length > 0, 'benchmark requires at least one sample');
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    meanMs: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    p50Ms: sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle],
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

function parseOptions(args: readonly string[]): BenchmarkOptions {
  const values = new Map<string, number>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const raw = args[index + 1];
    if (!key?.startsWith('--')) throw new Error(`Unknown argument: ${key}`);
    const name = key.slice(2);
    if (!['functions', 'iterations', 'warmup'].includes(name)) {
      throw new Error(`Unknown argument: ${key}`);
    }
    if (raw === undefined) throw new Error(`${key} requires a value`);
    const value = Number(raw);
    const minimum = name === 'warmup' ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`${key} must be an integer greater than or equal to ${minimum}`);
    }
    values.set(name, value);
  }
  return {
    functions: values.get('functions') ?? 2_000,
    iterations: values.get('iterations') ?? 40,
    warmup: values.get('warmup') ?? 10,
  };
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
