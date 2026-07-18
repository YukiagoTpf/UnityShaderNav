import { performance } from 'node:perf_hooks';

const DEFAULTS = Object.freeze({
  files: 5_000,
  symbols: 8,
  iterations: 100,
  warmup: 20,
});

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  const options = new Map([
    ['--files', 'files'],
    ['--symbols', 'symbols'],
    ['--iterations', 'iterations'],
    ['--warmup', 'warmup'],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const key = options.get(flag);
    if (!key) throw new Error(`Unknown argument: ${flag}`);
    if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    args[key] = Number(argv[++index]);
  }
  for (const [key, value] of Object.entries(args)) {
    const minimum = key === 'warmup' ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`--${key} must be an integer greater than or equal to ${minimum}`);
    }
  }
  return args;
}

function fileIndex(fileNumber, symbolCount, generation = 'base') {
  const uri = `file:///project/Assets/Shaders/File${fileNumber}.hlsl`;
  const symbols = Array.from({ length: symbolCount }, (_, symbolNumber) => ({
    name: `${generation}_Symbol${symbolNumber}`,
    kind: 'function',
    location: {
      uri,
      range: {
        start: { line: symbolNumber, character: 0 },
        end: { line: symbolNumber, character: 1 },
      },
    },
  }));
  const references = symbols.map((symbol) => ({
    name: symbol.name,
    context: 'call',
    location: symbol.location,
  }));
  return { uri, symbols, references };
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    medianMs: sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle],
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    samples: sorted.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { WorkspaceIndex } = await import('../server/out/workspace/workspaceIndex.js');
  const base = new WorkspaceIndex([], true);
  for (let index = 0; index < args.files; index++) {
    const file = fileIndex(index, args.symbols);
    base.restoreFromCache(file.uri, file);
  }
  const replacement = fileIndex(args.files - 1, args.symbols, 'changed');

  const run = () => {
    const candidate = base.fork();
    candidate.restoreFromCache(replacement.uri, replacement);
    return candidate;
  };
  for (let index = 0; index < args.warmup; index++) run();

  const samples = [];
  let candidate;
  for (let index = 0; index < args.iterations; index++) {
    const start = performance.now();
    candidate = run();
    samples.push(performance.now() - start);
  }

  if (!candidate?.file(replacement.uri)?.symbols[0].name.startsWith('changed_')) {
    throw new Error('Fork benchmark did not publish the changed file shard');
  }
  if (!base.file(replacement.uri)?.symbols[0].name.startsWith('base_')) {
    throw new Error('Fork benchmark mutated the captured base revision');
  }

  console.log(JSON.stringify({
    configuration: args,
    operation: 'fork one published index and replace one file shard',
    result: summarize(samples),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
