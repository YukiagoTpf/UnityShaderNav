import { describe, expect, it } from 'vitest';
import {
  asShaderLabPropertyType,
  builtinEntriesForContext,
  builtinLexicalRole,
  findBuiltinEntries,
  findBuiltinFunctions,
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

  it('keeps every entry unique, valid, and every function fully described', () => {
    const entries = allEntries();
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length);

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
