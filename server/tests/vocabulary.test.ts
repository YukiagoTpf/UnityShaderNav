import { describe, expect, it } from 'vitest';
import { BUILTIN_ENTRIES, type BuiltinCategory } from '../src/vocabulary';

describe('built-in vocabulary', () => {

  it('contains the high-signal vocabulary contract', () => {
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
    ]) {
      expect(BUILTIN_ENTRIES.map((entry) => entry.name)).toContain(name);
    }
  });

  it('contains the expanded vocabulary across categories', () => {
    for (const name of [
      // HLSL intrinsics + types
      'abs',
      'smoothstep',
      'fwidth',
      'discard',
      'Texture2D',
      'SamplerState',
      'StructuredBuffer',
      // UnityCG legacy
      'tex2Dlod',
      'UNITY_MATRIX_VP',
      '_Time',
      // URP/SRP Core
      'SAMPLE_TEXTURE2D_LOD',
      'TransformObjectToHClip',
      'GetMainLight',
      'UNITY_SETUP_INSTANCE_ID',
      // HDRP-specific
      'GetShadowFade',
      'MainLightRealtimeShadow',
      // New ShaderLab states + values
      'Stencil',
      'BlendOp',
      'Zero',
      'SrcAlpha',
      'OneMinusSrcAlpha',
      'Replace',
      // New semantics
      'SV_Depth',
      'SV_DispatchThreadID',
      'BLENDINDICES',
    ]) {
      expect(BUILTIN_ENTRIES.map((entry) => entry.name)).toContain(name);
    }
  });

  it('every function entry has returnType and parameters', () => {
    for (const entry of BUILTIN_ENTRIES) {
      if (entry.kind !== 'function') continue;
      expect(entry.returnType, `${entry.name} is missing returnType`).toBeTruthy();
      expect(Array.isArray(entry.parameters), `${entry.name} is missing parameters array`).toBe(true);
    }
  });

  it('uses only valid categories', () => {
    const categories = new Set<BuiltinCategory>([
      'hlsl',
      'unitycg',
      'urp',
      'hdrp',
      'shaderlab',
      'semantic',
    ]);

    for (const entry of BUILTIN_ENTRIES) {
      expect(categories.has(entry.category)).toBe(true);
    }
  });
});
