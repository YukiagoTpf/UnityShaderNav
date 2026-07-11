import { performance } from 'node:perf_hooks';

const DEFAULTS = Object.freeze({
  iterations: 250,
  warmup: 50,
  passes: 32,
  properties: 64,
});

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  const options = new Map([
    ['--iterations', 'iterations'],
    ['--warmup', 'warmup'],
    ['--passes', 'passes'],
    ['--properties', 'properties'],
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

function createShaderSource(passCount, propertyCount) {
  const lines = [
    'Shader "Hidden/UnityShaderNav/DocumentAnalysisBenchmark"',
    '{',
    '  Properties',
    '  {',
  ];

  for (let index = 0; index < propertyCount; index++) {
    lines.push(`    _Bench${index} ("Benchmark ${index}", Float) = ${index % 11}`);
  }

  lines.push(
    '  }',
    '  HLSLINCLUDE',
    '  struct SharedInput { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };',
    '  float4 SharedTransform(SharedInput input) { return input.positionOS; }',
    '  ENDHLSL',
    '  SubShader',
    '  {',
    '    Tags { "RenderType" = "Opaque" "Queue" = "Geometry" }',
  );

  for (let index = 0; index < passCount; index++) {
    lines.push(
      '    Pass',
      '    {',
      `      Name "BenchmarkPass${index}"`,
      '      Cull Back',
      '      ZWrite On',
      '      HLSLPROGRAM',
      `      #pragma vertex BenchVertex${index}`,
      `      #pragma fragment BenchFragment${index}`,
      `      float4 BenchVertex${index}(SharedInput input) : SV_POSITION`,
      '      {',
      `        return SharedTransform(input) + float4(${index % 7}.0, 0.0, 0.0, 0.0);`,
      '      }',
      `      float4 BenchFragment${index}() : SV_Target`,
      '      {',
      `        return float4(${(index % 5) / 4}, 0.5, 1.0, 1.0);`,
      '      }',
      '      ENDHLSL',
      '    }',
    );
  }

  lines.push('  }', '}', '');
  return lines.join('\n');
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  return { medianMs: median, p95Ms: p95, samples: sorted.length };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function assertSameCounts(legacy, shared) {
  for (const key of ['blocks', 'properties', 'structureNodes', 'lexicalTokens']) {
    if (legacy[key] !== shared[key]) {
      throw new Error(
        `Benchmark paths disagree on ${key}: legacy=${legacy[key]}, shared=${shared[key]}`,
      );
    }
  }
}

function countStructureNodes(structure) {
  const count = (nodes) => nodes.reduce(
    (total, node) => total + 1 + count(node.children),
    0,
  );
  return count(structure.shaders);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = createShaderSource(args.passes, args.properties);
  const uri = 'file:///DocumentAnalysisBenchmark.shader';
  const [
    { scanBlocks },
    { scanProperties },
    { scanStructure },
    { scanShaderLabTokens },
    { analyzeDocument },
  ] = await Promise.all([
    import('../server/out/parser/shaderlab/blockScanner.js'),
    import('../server/out/parser/shaderlab/propertiesScanner.js'),
    import('../server/out/parser/shaderlab/structureScanner.js'),
    import('../server/out/parser/shaderlab/tokenScanner.js'),
    import('../server/out/analysis/documentAnalysis.js'),
  ]);

  function runLegacyCycle() {
    const indexBlocks = scanBlocks(source).blocks;
    const properties = scanProperties(source);
    const structure = scanStructure(source);
    const tokenBlocks = scanBlocks(source).blocks;
    const lexicalTokens = scanShaderLabTokens(source, tokenBlocks);
    return {
      blocks: indexBlocks.length,
      properties: properties.length,
      structureNodes: countStructureNodes(structure),
      lexicalTokens: lexicalTokens.length,
    };
  }

  function runSharedCycle() {
    const analysis = analyzeDocument(uri, source, 'full');
    if (!analysis?.lexicalTokens) {
      throw new Error('Expected a full ShaderLab DocumentAnalysis result');
    }
    const properties = scanProperties(source, analysis.blocks);
    return {
      blocks: analysis.blocks.length,
      properties: properties.length,
      structureNodes: countStructureNodes(analysis.structure),
      lexicalTokens: analysis.lexicalTokens.length,
    };
  }

  const expectedLegacy = runLegacyCycle();
  const expectedShared = runSharedCycle();
  assertSameCounts(expectedLegacy, expectedShared);

  for (let index = 0; index < args.warmup; index++) {
    if (index % 2 === 0) {
      runLegacyCycle();
      runSharedCycle();
    } else {
      runSharedCycle();
      runLegacyCycle();
    }
  }

  const legacySamples = [];
  const sharedSamples = [];
  let checksum = 0;

  function measure(run, samples) {
    const start = performance.now();
    const counts = run();
    samples.push(performance.now() - start);
    checksum += counts.blocks
      + counts.properties
      + counts.structureNodes
      + counts.lexicalTokens;
  }

  for (let index = 0; index < args.iterations; index++) {
    if (index % 2 === 0) {
      measure(runLegacyCycle, legacySamples);
      measure(runSharedCycle, sharedSamples);
    } else {
      measure(runSharedCycle, sharedSamples);
      measure(runLegacyCycle, legacySamples);
    }
  }

  const legacy = summarize(legacySamples);
  const shared = summarize(sharedSamples);
  console.log(JSON.stringify({
    configuration: {
      iterations: args.iterations,
      warmup: args.warmup,
      passes: args.passes,
      properties: args.properties,
      sourceBytes: Buffer.byteLength(source),
    },
    counts: expectedShared,
    legacy,
    shared,
    sharedToLegacyRatio: {
      median: ratio(shared.medianMs, legacy.medianMs),
      p95: ratio(shared.p95Ms, legacy.p95Ms),
    },
    checksum,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
