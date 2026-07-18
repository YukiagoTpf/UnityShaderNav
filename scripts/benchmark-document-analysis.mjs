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
    lines.push(index === 0
      ? '    [HDR] _Bench0 ("Benchmark 0", Color) = (1.0, 0.5, 0.25, 1.0)'
      : `    _Bench${index} ("Benchmark ${index}", Float) = ${index % 11}`);
  }

  lines.push(
    '  }',
    '  HLSLINCLUDE',
    '  #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Common.hlsl"',
    '  CBUFFER_START(UnityPerMaterial)',
    '    float4 _Bench0;',
    '    float _Bench1;',
    '  CBUFFER_END',
    '  struct SharedInput { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };',
    '  float4 SharedTransform(SharedInput input) { return input.positionOS; }',
    '  ENDHLSL',
    '  SubShader',
    '  {',
    '    Tags { "RenderType" = "Opaque" "Queue" = "Geometry" "RenderPipeline" = "UniversalPipeline" }',
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

  lines.push(
    '    UsePass "Hidden/Other/FORWARD"',
    '  }',
    '  Fallback "Hidden/Fallback"',
    '}',
    '',
  );
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

const COUNT_KEYS = Object.freeze([
  'blocks',
  'layoutIssues',
  'properties',
  'literalColors',
  'structureNodes',
  'shaderNames',
  'passNames',
  'nameReferences',
  'materialCbuffers',
  'materialFields',
  'programBlocks',
  'srpEvidence',
  'hasIncludes',
  'lexicalTokens',
]);

function assertSameCounts(independent, shared) {
  for (const key of COUNT_KEYS) {
    if (independent[key] !== shared[key]) {
      throw new Error(
        `Benchmark paths disagree on ${key}: independent=${independent[key]}, shared=${shared[key]}`,
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
    { scanShaderLabLayout },
    { scanShaderLabNames },
    { scanShaderLabMaterialFacts },
    { scanShaderLabPropertyFacts },
    { scanShaderLabTokens },
    { analyzeDocument },
  ] = await Promise.all([
    import('../server/out/parser/shaderlab/layoutScanner.js'),
    import('../server/out/parser/shaderlab/nameScanner.js'),
    import('../server/out/parser/shaderlab/materialCbufferScanner.js'),
    import('../server/out/parser/shaderlab/propertiesScanner.js'),
    import('../server/out/parser/shaderlab/tokenScanner.js'),
    import('../server/out/analysis/documentAnalysis.js'),
  ]);

  function countsOf(layout, names, material, properties, lexicalTokens) {
    return {
      blocks: layout.blocks.length,
      layoutIssues: layout.issues.length,
      properties: properties.entries.length,
      literalColors: properties.literalColors.length,
      structureNodes: countStructureNodes(layout.structure),
      shaderNames: names.shaders.length,
      passNames: names.passes.length,
      nameReferences: names.references.length,
      materialCbuffers: material.cbuffers.length,
      materialFields: material.cbuffers.reduce((total, cbuffer) => total + cbuffer.fields.length, 0),
      programBlocks: material.programBlocks.length,
      srpEvidence: Number(material.srpEvidence),
      hasIncludes: Number(material.hasIncludes),
      lexicalTokens: lexicalTokens.length,
    };
  }

  function runIndependentCycle() {
    const layout = scanShaderLabLayout(source);
    const names = scanShaderLabNames(source, layout.blocks, layout.structure);
    const material = scanShaderLabMaterialFacts(source, layout.blocks, layout.structure);
    const properties = scanShaderLabPropertyFacts(source, layout.blocks);
    const lexicalTokens = scanShaderLabTokens(source, layout.blocks);
    return countsOf(layout, names, material, properties, lexicalTokens);
  }

  function runSharedCycle() {
    const analysis = analyzeDocument(uri, source, 'full');
    if (!analysis?.lexicalTokens) {
      throw new Error('Expected a full ShaderLab DocumentAnalysis result');
    }
    return countsOf(
      analysis.layout,
      analysis.shaderLabNames,
      analysis.shaderLabMaterial,
      analysis.shaderLabProperties,
      analysis.lexicalTokens,
    );
  }

  const expectedIndependent = runIndependentCycle();
  const expectedShared = runSharedCycle();
  assertSameCounts(expectedIndependent, expectedShared);
  const sourceWalks = { independent: 5, shared: 1 };
  if (sourceWalks.shared >= sourceWalks.independent) {
    throw new Error('Shared DocumentAnalysis must perform fewer source interpretations');
  }

  for (let index = 0; index < args.warmup; index++) {
    if (index % 2 === 0) {
      runIndependentCycle();
      runSharedCycle();
    } else {
      runSharedCycle();
      runIndependentCycle();
    }
  }

  const independentSamples = [];
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
      measure(runIndependentCycle, independentSamples);
      measure(runSharedCycle, sharedSamples);
    } else {
      measure(runSharedCycle, sharedSamples);
      measure(runIndependentCycle, independentSamples);
    }
  }

  const independent = summarize(independentSamples);
  const shared = summarize(sharedSamples);
  console.log(JSON.stringify({
    configuration: {
      iterations: args.iterations,
      warmup: args.warmup,
      passes: args.passes,
      properties: args.properties,
      sourceBytes: Buffer.byteLength(source),
    },
    sourceWalks: {
      ...sourceWalks,
      reduction: sourceWalks.independent - sourceWalks.shared,
    },
    counts: expectedShared,
    independent,
    shared,
    sharedToIndependentRatio: {
      median: ratio(shared.medianMs, independent.medianMs),
      p95: ratio(shared.p95Ms, independent.p95Ms),
    },
    checksum,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
