import { describe, expect, it } from 'vitest';
import {
  asShaderLabPropertyType,
  builtinEntriesForContext,
  builtinMemberEntriesForReceiverType,
  builtinLexicalRole,
  findBuiltinEntries,
  findBuiltinFunctions,
  findBuiltinMemberFunctions,
  isShaderLabStateValueContext,
  type BuiltinCategory,
  type BuiltinContext,
  type BuiltinEntry,
} from '../src/vocabulary';

const CONTEXTS: readonly BuiltinContext[] = [
  'hlsl',
  'semantic',
  'shaderLab',
  'shaderLabStateValue',
];

function allEntries(): BuiltinEntry[] {
  return CONTEXTS.flatMap((context) => [...builtinEntriesForContext(context)]);
}

describe('built-in vocabulary', () => {
  it('projects Unity globals as typed variables in HLSL code', () => {
    expect(findBuiltinEntries('_ScreenParams')).toEqual([
      expect.objectContaining({
        name: '_ScreenParams',
        kind: 'variable',
        category: 'unitycg',
        declaredType: 'float4',
      }),
    ]);
    expect(builtinEntriesForContext('hlsl').map((entry) => entry.name))
      .toContain('_ScreenParams');
  });

  it('projects HLSL variables and keywords through neutral lexical roles', () => {
    expect(builtinLexicalRole('_ScreenParams', 'hlsl')).toBe('variable');
    expect(builtinLexicalRole('groupshared', 'hlsl')).toBe('keyword');
  });

  it('projects texture methods only for a compatible generic receiver type', () => {
    expect(builtinMemberEntriesForReceiverType('Texture2D<float4>', 'Sam'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'Sample',
          kind: 'function',
          parentType: 'Texture2D',
        }),
      ]));
    expect(builtinEntriesForContext('hlsl').map((entry) => entry.name))
      .not.toContain('Sample');
  });

  it('preserves texture method overloads for receiver-aware Signature Help', () => {
    expect(findBuiltinMemberFunctions('Texture2D<float4>', 'Sample')
      .map((entry) => entry.parameters?.length)).toEqual([2, 3]);
    expect(findBuiltinFunctions('Sample')).toEqual([]);
  });

  it('covers texture-object method families only on compatible receiver types', () => {
    const commonSampling = ['Sample', 'SampleLevel', 'SampleBias', 'SampleGrad', 'GetDimensions'];
    const expectedMethods = new Map<string, readonly string[]>([
      ['Texture1D<float4>', [...commonSampling, 'SampleCmp', 'Load']],
      ['Texture1DArray<float4>', [...commonSampling, 'SampleCmp', 'Load']],
      ['Texture2D<float4>', [...commonSampling, 'SampleCmp', 'Load', 'Gather', 'GatherRed', 'GatherGreen', 'GatherBlue', 'GatherAlpha']],
      ['Texture2DArray<float4>', [...commonSampling, 'SampleCmp', 'Load', 'Gather', 'GatherRed', 'GatherGreen', 'GatherBlue', 'GatherAlpha']],
      ['Texture3D<float4>', [...commonSampling, 'Load']],
      ['TextureCube<float4>', [...commonSampling, 'SampleCmp', 'Gather', 'GatherRed', 'GatherGreen', 'GatherBlue', 'GatherAlpha']],
      ['TextureCubeArray<float4>', [...commonSampling, 'SampleCmp', 'Gather', 'GatherRed', 'GatherGreen', 'GatherBlue', 'GatherAlpha']],
    ]);

    for (const [receiverType, methodNames] of expectedMethods) {
      const names = new Set(builtinMemberEntriesForReceiverType(receiverType)
        .map((entry) => entry.name));
      for (const name of methodNames) {
        expect(names.has(name), `${receiverType}.${name}`).toBe(true);
      }
      expect(
        findBuiltinMemberFunctions(receiverType, 'GetDimensions'),
        `${receiverType}.GetDimensions overloads`,
      ).toHaveLength(4);
    }

    expect(findBuiltinMemberFunctions('Texture2D<float4>', 'SampleLevel')
      .map((entry) => entry.parameters?.length)).toEqual([3, 4]);
    expect(findBuiltinMemberFunctions('TextureCube<float4>', 'SampleLevel')
      .map((entry) => entry.parameters?.length)).toEqual([3]);
    expect(findBuiltinMemberFunctions('Texture2D<float4>', 'Load')[0].parameters?.[0])
      .toEqual({ type: 'int3', name: 'location' });
    expect(findBuiltinMemberFunctions('Texture2DArray<float4>', 'GatherRed')[0].parameters?.[1])
      .toEqual({ type: 'float3', name: 'location' });
    expect(findBuiltinMemberFunctions('Texture2D<float4>', 'GetDimensions')
      .map((entry) => entry.parameters)).toEqual([
      [
        { type: 'out uint', name: 'width' },
        { type: 'out uint', name: 'height' },
      ],
      [
        { type: 'uint', name: 'mipLevel' },
        { type: 'out uint', name: 'width' },
        { type: 'out uint', name: 'height' },
        { type: 'out uint', name: 'numberOfLevels' },
      ],
      [
        { type: 'out float', name: 'width' },
        { type: 'out float', name: 'height' },
      ],
      [
        { type: 'uint', name: 'mipLevel' },
        { type: 'out float', name: 'width' },
        { type: 'out float', name: 'height' },
        { type: 'out float', name: 'numberOfLevels' },
      ],
    ]);
    expect(findBuiltinMemberFunctions('Texture3D<float4>', 'SampleCmp')).toEqual([]);
    expect(findBuiltinMemberFunctions('TextureCube<float4>', 'Load')).toEqual([]);
    expect(findBuiltinMemberFunctions('Texture3D<float4>', 'Gather')).toEqual([]);
    expect(findBuiltinEntries('Texture2DArray')).toContainEqual(expect.objectContaining({
      typeShape: { kind: 'texture', dimensions: 2, array: true },
    }));

    const freeNames = new Set(builtinEntriesForContext('hlsl').map((entry) => entry.name));
    for (const name of ['Sample', 'SampleLevel', 'SampleBias', 'SampleGrad', 'SampleCmp', 'Load', 'Gather', 'GatherRed', 'GatherGreen', 'GatherBlue', 'GatherAlpha', 'GetDimensions']) {
      expect(freeNames.has(name), name).toBe(false);
    }
  });

  it('preserves the official TextureCube level-count type for float dimensions', () => {
    const floatMipDimensions = findBuiltinMemberFunctions(
      'TextureCube<float4>',
      'GetDimensions',
    ).find((entry) => (
      entry.parameters?.[0]?.name === 'mipLevel'
      && entry.parameters?.[1]?.type === 'out float'
    ));

    expect(floatMipDimensions?.parameters).toEqual([
      { type: 'uint', name: 'mipLevel' },
      { type: 'out float', name: 'width' },
      { type: 'out float', name: 'height' },
      { type: 'out uint', name: 'numberOfLevels' },
    ]);
  });

  it('generates dimension-safe vector swizzles with declared result types', () => {
    const swizzles = builtinMemberEntriesForReceiverType('float3');
    expect(swizzles).toHaveLength(240);
    expect(swizzles).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'x', kind: 'structMember', declaredType: 'float' }),
      expect.objectContaining({ name: 'xyz', declaredType: 'float3' }),
      expect.objectContaining({ name: 'rgbb', declaredType: 'float4' }),
    ]));
    expect(swizzles.map((entry) => entry.name)).not.toEqual(expect.arrayContaining([
      'w',
      'a',
      'xg',
    ]));
  });

  it('generates only vector swizzles matching the requested prefix', () => {
    const swizzles = builtinMemberEntriesForReceiverType('float4', 'x');
    expect(swizzles).toHaveLength(85);
    expect(swizzles.every((entry) => entry.name.startsWith('x'))).toBe(true);
    expect(builtinMemberEntriesForReceiverType('float4', 'xg')).toEqual([]);
  });

  it('generates bounded zero-based and one-based matrix component members', () => {
    const components = builtinMemberEntriesForReceiverType('float3x4', '_');
    expect(components).toHaveLength(24);
    expect(components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '_m00', kind: 'structMember', declaredType: 'float' }),
      expect.objectContaining({ name: '_m23', declaredType: 'float' }),
      expect.objectContaining({ name: '_11', declaredType: 'float' }),
      expect.objectContaining({ name: '_34', declaredType: 'float' }),
    ]));
    expect(components.map((entry) => entry.name)).not.toEqual(expect.arrayContaining([
      '_m30',
      '_41',
    ]));
  });

  it('derives vector and matrix members from generic HLSL type forms', () => {
    const vectorMembers = builtinMemberEntriesForReceiverType('vector<float, 3>', 'z');
    expect(vectorMembers).toHaveLength(40);
    expect(vectorMembers.every((entry) => entry.name.startsWith('z'))).toBe(true);

    const matrixMembers = builtinMemberEntriesForReceiverType('matrix<half, 2, 3>', '_m');
    expect(matrixMembers).toHaveLength(6);
    expect(matrixMembers).toContainEqual(expect.objectContaining({
      name: '_m12',
      declaredType: 'half',
    }));
  });

  it('applies the official vector and matrix template defaults during member lookup', () => {
    for (const receiverType of ['vector<float>', 'vector']) {
      const members = builtinMemberEntriesForReceiverType(receiverType, 'w');
      expect(members).toHaveLength(85);
      expect(members).toContainEqual(expect.objectContaining({
        name: 'wwww',
        declaredType: 'float4',
      }));
    }

    expect(builtinMemberEntriesForReceiverType('vector<float, 1>', 'x'))
      .toEqual([
        expect.objectContaining({ name: 'x', declaredType: 'float' }),
        expect.objectContaining({ name: 'xx', declaredType: 'float2' }),
        expect.objectContaining({ name: 'xxx', declaredType: 'float3' }),
        expect.objectContaining({ name: 'xxxx', declaredType: 'float4' }),
      ]);

    const twoByDefaultColumns = builtinMemberEntriesForReceiverType('matrix<float, 2>', '_m');
    expect(twoByDefaultColumns).toHaveLength(8);
    expect(twoByDefaultColumns).toContainEqual(expect.objectContaining({ name: '_m13' }));
    expect(twoByDefaultColumns.map((entry) => entry.name)).not.toContain('_m20');

    for (const receiverType of ['matrix<float>', 'matrix']) {
      const members = builtinMemberEntriesForReceiverType(receiverType, '_m');
      expect(members).toHaveLength(16);
      expect(members).toContainEqual(expect.objectContaining({
        name: '_m33',
        declaredType: 'float',
      }));
    }

    expect(builtinMemberEntriesForReceiverType('matrix<float, 1, 4>', '_m'))
      .toHaveLength(4);
    expect(builtinMemberEntriesForReceiverType('vector<float, 5>', 'x')).toEqual([]);
    expect(builtinMemberEntriesForReceiverType('matrix<float, 5>', '_m')).toEqual([]);
    expect(builtinMemberEntriesForReceiverType('matrix<float, 2, 5>', '_m')).toEqual([]);
  });

  it('covers advanced HLSL intrinsic, wave, and quad families with signatures', () => {
    for (const name of [
      'sincos',
      'asfloat',
      'asint',
      'asuint',
      'isnan',
      'isinf',
      'isfinite',
      'trunc',
      'ldexp',
      'frexp',
      'modf',
      'log10',
      'sinh',
      'cosh',
      'tanh',
      'reversebits',
      'firstbitlow',
      'firstbithigh',
      'msad4',
      'WaveActiveSum',
      'WaveReadLaneAt',
      'WavePrefixCountBits',
      'WaveMatch',
      'WaveMultiPrefixSum',
      'WaveMultiPrefixProduct',
      'WaveMultiPrefixBitAnd',
      'WaveMultiPrefixBitOr',
      'WaveMultiPrefixBitXor',
      'QuadReadAcrossX',
      'QuadReadLaneAt',
    ]) {
      expect(findBuiltinFunctions(name), name).not.toEqual([]);
    }
    expect(findBuiltinFunctions('sincos')[0].parameters).toEqual([
      { type: 'T', name: 'x' },
      { type: 'out T', name: 'sine' },
      { type: 'out T', name: 'cosine' },
    ]);
    expect(findBuiltinFunctions('ldexp')[0].parameters).toEqual([
      { type: 'T', name: 'x' },
      { type: 'T', name: 'exponent' },
    ]);
    expect(findBuiltinFunctions('frexp')[0].parameters).toEqual([
      { type: 'T', name: 'x' },
      { type: 'out T', name: 'exponent' },
    ]);
    expect(findBuiltinFunctions('WaveMultiPrefixSum')[0]).toMatchObject({
      returnType: 'T',
      parameters: [
        { type: 'T', name: 'value' },
        { type: 'uint4', name: 'mask' },
      ],
    });
  });

  it('preserves intrinsic result shapes instead of presenting vector calls as scalars', () => {
    expect(findBuiltinFunctions('asfloat')).toEqual([
      expect.objectContaining({
        returnType: 'float<x>',
        parameters: [{ type: 'float<x>', name: 'x' }],
      }),
      expect.objectContaining({
        returnType: 'float<x>',
        parameters: [{ type: 'int<x>', name: 'x' }],
      }),
      expect.objectContaining({
        returnType: 'float<x>',
        parameters: [{ type: 'uint<x>', name: 'x' }],
      }),
    ]);
    expect(findBuiltinFunctions('asint')).toEqual([
      expect.objectContaining({
        returnType: 'int<x>',
        parameters: [{ type: 'float<x>', name: 'x' }],
      }),
      expect.objectContaining({
        returnType: 'int<x>',
        parameters: [{ type: 'uint<x>', name: 'x' }],
      }),
    ]);
    expect(findBuiltinFunctions('asuint')).toEqual([
      expect.objectContaining({
        returnType: 'uint<x>',
        parameters: [{ type: 'float<x>', name: 'x' }],
      }),
      expect.objectContaining({
        returnType: 'uint<x>',
        parameters: [{ type: 'int<x>', name: 'x' }],
      }),
    ]);
    for (const name of ['isnan', 'isinf', 'isfinite']) {
      expect(findBuiltinFunctions(name)).toEqual([
        expect.objectContaining({
          returnType: 'bool<x>',
          parameters: [{ type: 'float<x>', name: 'x' }],
        }),
      ]);
    }
    expect(findBuiltinFunctions('reversebits')).toEqual([
      expect.objectContaining({
        returnType: 'uint<x>',
        parameters: [{ type: 'uint<x>', name: 'x' }],
      }),
    ]);
    for (const name of ['firstbitlow', 'firstbithigh']) {
      expect(findBuiltinFunctions(name)).toEqual([
        expect.objectContaining({
          returnType: 'int<x>',
          parameters: [{ type: 'int<x>', name: 'x' }],
        }),
        expect.objectContaining({
          returnType: 'uint<x>',
          parameters: [{ type: 'uint<x>', name: 'x' }],
        }),
      ]);
    }
  });

  it('covers precision, generic, matrix, and sampler type families with member shapes', () => {
    for (const name of [
      'float',
      'fixed',
      'fixed4',
      'double',
      'double4',
      'min16float',
      'min16float3',
      'min10float4',
      'min16int2',
      'min12int3',
      'min16uint4',
      'real',
      'real3',
      'vector',
      'matrix',
      'float2x3',
      'half4x2',
      'double3x4',
      'sampler',
      'sampler1D',
      'sampler2D',
      'sampler3D',
      'samplerCUBE',
    ]) {
      expect(findBuiltinEntries(name), name).not.toEqual([]);
    }
    expect(builtinMemberEntriesForReceiverType('double4', 'w')).toHaveLength(85);
    expect(builtinMemberEntriesForReceiverType('half4x2', '_m')).toHaveLength(8);
  });

  it('covers the legal one-component vector and one-row or one-column matrix types', () => {
    for (const elementType of [
      'float',
      'half',
      'fixed',
      'double',
      'min16float',
      'min10float',
      'min16int',
      'min12int',
      'min16uint',
      'real',
      'int',
      'uint',
      'bool',
    ]) {
      expect(findBuiltinEntries(`${elementType}1`), elementType).toContainEqual(
        expect.objectContaining({
          kind: 'type',
          typeShape: { kind: 'vector', elementType, size: 1 },
        }),
      );
    }

    expect(findBuiltinEntries('float1x4')).toContainEqual(expect.objectContaining({
      kind: 'type',
      typeShape: { kind: 'matrix', elementType: 'float', rows: 1, columns: 4 },
    }));
    expect(findBuiltinEntries('half4x1')).toContainEqual(expect.objectContaining({
      kind: 'type',
      typeShape: { kind: 'matrix', elementType: 'half', rows: 4, columns: 1 },
    }));
    expect(findBuiltinEntries('double1x1')).toContainEqual(expect.objectContaining({
      kind: 'type',
      typeShape: { kind: 'matrix', elementType: 'double', rows: 1, columns: 1 },
    }));

    expect(builtinMemberEntriesForReceiverType('float1', 'x').map((entry) => entry.name))
      .toEqual(['x', 'xx', 'xxx', 'xxxx']);
    expect(builtinMemberEntriesForReceiverType('float1', 'r').map((entry) => entry.name))
      .toEqual(['r', 'rr', 'rrr', 'rrrr']);
    expect(builtinMemberEntriesForReceiverType('float1', 'xr')).toEqual([]);
    expect(builtinMemberEntriesForReceiverType('float1x4', '_m'))
      .toHaveLength(4);
    expect(findBuiltinEntries('float0')).toEqual([]);
    expect(findBuiltinEntries('float5')).toEqual([]);
    expect(findBuiltinEntries('float0x4')).toEqual([]);
    expect(findBuiltinEntries('float1x5')).toEqual([]);
  });

  it('covers HLSL control-flow, storage, parameter, and interpolation keywords', () => {
    for (const name of [
      'if',
      'else',
      'for',
      'while',
      'do',
      'switch',
      'case',
      'default',
      'break',
      'continue',
      'return',
      'in',
      'out',
      'inout',
      'const',
      'static',
      'uniform',
      'register',
      'packoffset',
      'groupshared',
      'numthreads',
      'precise',
      'linear',
      'centroid',
      'nointerpolation',
      'noperspective',
      'sample',
    ]) {
      expect(findBuiltinEntries(name), name).toContainEqual(expect.objectContaining({
        kind: 'keyword',
        category: 'hlsl',
      }));
      expect(builtinLexicalRole(name, 'hlsl'), name).toBe('keyword');
    }
  });

  it('models Unity built-in globals separately from matrix and flow-control macros', () => {
    const globals = new Map([
      ['_ScreenParams', 'float4'],
      ['_ProjectionParams', 'float4'],
      ['_ZBufferParams', 'float4'],
      ['_WorldSpaceLightPos0', 'float4'],
      ['_LightColor0', 'fixed4'],
      ['unity_MatrixVP', 'float4x4'],
      ['_WorldSpaceCameraPos', 'float3'],
      ['_Time', 'float4'],
      ['_SinTime', 'float4'],
      ['_CosTime', 'float4'],
    ]);
    for (const [name, declaredType] of globals) {
      expect(findBuiltinEntries(name), name).toContainEqual(expect.objectContaining({
        kind: 'variable',
        category: 'unitycg',
        declaredType,
      }));
      expect(builtinLexicalRole(name, 'hlsl'), name).toBe('variable');
    }

    for (const name of [
      'UNITY_PI',
      'UNITY_MATRIX_I_M',
      'UNITY_MATRIX_I_V',
      'UNITY_MATRIX_I_P',
      'UNITY_MATRIX_I_VP',
      'UNITY_BRANCH',
      'UNITY_FLATTEN',
      'UNITY_UNROLL',
      'UNITY_UNROLLX',
      'UNITY_LOOP',
      'UNITY_INITIALIZE_OUTPUT',
    ]) {
      expect(findBuiltinEntries(name), name).toContainEqual(expect.objectContaining({
        kind: 'macro',
        category: 'unitycg',
      }));
      expect(builtinLexicalRole(name, 'hlsl'), name).toBe('macro');
    }
  });

  it('covers URP texture, lighting, fog, GI, and surface-data families', () => {
    for (const name of ['SAMPLE_TEXTURE2D_X', 'SAMPLE_TEXTURE2D_X_LOD', 'SAMPLE_GI']) {
      expect(findBuiltinEntries(name), name).toContainEqual(expect.objectContaining({
        kind: 'macro',
        category: 'urp',
      }));
    }
    for (const name of ['InputData', 'SurfaceData']) {
      expect(findBuiltinEntries(name), name).toContainEqual(expect.objectContaining({
        kind: 'type',
        category: 'urp',
      }));
    }
    for (const name of ['GetShadowCoord', 'SampleSH', 'MixFog']) {
      expect(findBuiltinFunctions(name), name).toContainEqual(expect.objectContaining({
        kind: 'function',
        category: 'urp',
        parameters: expect.any(Array),
      }));
    }
    expect(findBuiltinFunctions('GetShadowCoord')[0]).toMatchObject({
      returnType: 'float4',
      parameters: [{ type: 'VertexPositionInputs', name: 'positionInputs' }],
    });
  });

  it('contains the high-signal and expanded vocabulary contract', () => {
    for (const name of [
      'normalize',
      'dot',
      'lerp',
      'saturate',
      'mul',
      'tex2D',
      'float4',
      'half4',
      'UnityObjectToClipPos',
      'TRANSFORM_TEX',
      'SAMPLE_TEXTURE2D',
      'TEXTURE2D',
      'SAMPLER',
      'Blend',
      'Cull',
      'ZWrite',
      'ZTest',
      'Pass',
      'SubShader',
      'UsePass',
      '2DArray',
      'CubeArray',
      'POSITION',
      'SV_POSITION',
      'SV_Target',
      'TEXCOORD0',
      'Off',
      'On',
      'Back',
      'Front',
      'Always',
      'LEqual',
      'abs',
      'smoothstep',
      'fwidth',
      'discard',
      'Texture2D',
      'SamplerState',
      'StructuredBuffer',
      'tex2Dlod',
      'UNITY_MATRIX_VP',
      '_Time',
      'SAMPLE_TEXTURE2D_LOD',
      'TransformObjectToHClip',
      'GetMainLight',
      'UNITY_SETUP_INSTANCE_ID',
      'GetShadowFade',
      'MainLightRealtimeShadow',
      'Stencil',
      'BlendOp',
      'Zero',
      'SrcAlpha',
      'OneMinusSrcAlpha',
      'Replace',
      'SV_Depth',
      'SV_DispatchThreadID',
      'BLENDINDICES',
    ]) {
      expect(findBuiltinEntries(name), name).not.toEqual([]);
    }
  });

  it('owns ShaderLab roles and their lexical/property/context projections', () => {
    expect(findBuiltinEntries('UsePass')[0]).toMatchObject({
      kind: 'keyword',
      category: 'shaderlab',
      roles: ['shaderLabKeyword'],
    });
    expect(builtinLexicalRole('UsePass', 'shaderLab')).toBe('keyword');
    expect(builtinLexicalRole('UsePass', 'hlsl')).toBeUndefined();
    expect(findBuiltinEntries('usepass')).toEqual([]);

    for (const name of ['2DArray', 'CubeArray', 'Integer']) {
      expect(findBuiltinEntries(name)[0]).toMatchObject({
        kind: 'type',
        category: 'shaderlab',
        roles: ['shaderLabPropertyType'],
      });
      expect(asShaderLabPropertyType(name)).toBe(name);
      expect(builtinLexicalRole(name, 'shaderLabProperty')).toBe('type');
      expect(builtinLexicalRole(name, 'hlsl')).toBeUndefined();
    }

    expect(findBuiltinEntries('Blend')[0].roles).toEqual([
      'shaderLabRenderState',
      'shaderLabStateValueContext',
    ]);
    expect(isShaderLabStateValueContext('Blend')).toBe(true);
    expect(findBuiltinEntries('Off')[0].roles).toEqual(['shaderLabStateValue']);
    expect(isShaderLabStateValueContext('Off')).toBe(false);
    expect(isShaderLabStateValueContext('blend')).toBe(false);
    expect(asShaderLabPropertyType('2darray')).toBeNull();
    expect(asShaderLabPropertyType('Unknown')).toBeNull();
  });

  it('projects stable completion contexts without cross-category leakage', () => {
    const names = (context: BuiltinContext) => (
      builtinEntriesForContext(context).map((entry) => entry.name)
    );

    expect(names('hlsl')).toEqual(expect.arrayContaining(['normalize', 'GetMainLight']));
    expect(names('hlsl')).not.toEqual(expect.arrayContaining(['UsePass', '2DArray', 'Off']));
    expect(names('semantic')).toEqual(expect.arrayContaining(['SV_Target', 'TEXCOORD0']));
    expect(names('semantic')).not.toEqual(expect.arrayContaining(['normalize', 'UsePass']));
    expect(names('shaderLab')).toEqual(expect.arrayContaining([
      'UsePass',
      'Blend',
      '2DArray',
      'CubeArray',
    ]));
    expect(names('shaderLab')).not.toContain('Off');
    expect(names('shaderLabStateValue')).toEqual(expect.arrayContaining([
      'Off',
      'SrcAlpha',
      'Replace',
    ]));
    expect(names('shaderLabStateValue')).not.toContain('Blend');
  });

  it('finds only callable entries with parameter metadata for Signature Help', () => {
    expect(findBuiltinFunctions('normalize')).toEqual([
      expect.objectContaining({
        name: 'normalize',
        kind: 'function',
        parameters: [{ type: 'T', name: 'x' }],
      }),
    ]);
    expect(findBuiltinFunctions('float4')).toEqual([]);
    expect(findBuiltinFunctions('missing')).toEqual([]);
  });

  it('keeps every overload identity unique, every non-function name unique, and every function fully described', () => {
    const entries = allEntries();
    const identities = entries.map((entry) => entry.kind === 'function'
      ? [
        entry.name,
        entry.returnType,
        entry.parameters?.map((parameter) => parameter.type).join(','),
      ].join('|')
      : entry.name);
    expect(new Set(identities).size).toBe(entries.length);

    const entriesByName = new Map<string, BuiltinEntry[]>();
    for (const entry of entries) {
      entriesByName.set(entry.name, [...(entriesByName.get(entry.name) ?? []), entry]);
    }
    for (const [name, sameNameEntries] of entriesByName) {
      if (sameNameEntries.length === 1) continue;
      expect(sameNameEntries.every((entry) => entry.kind === 'function'), name).toBe(true);
    }

    const categories = new Set<BuiltinCategory>([
      'hlsl',
      'unitycg',
      'srp-core',
      'urp',
      'hdrp',
      'shaderlab',
      'semantic',
    ]);
    for (const entry of entries) {
      expect(categories.has(entry.category), entry.name).toBe(true);
      if (entry.kind !== 'function') continue;
      expect(entry.returnType, entry.name + ' is missing returnType').toBeTruthy();
      expect(Array.isArray(entry.parameters), entry.name + ' is missing parameters array')
        .toBe(true);
    }
  });
});
