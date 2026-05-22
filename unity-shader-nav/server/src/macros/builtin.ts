import type { DeclarationMacroKind } from '@unity-shader-nav/shared';

export interface BuiltinMacroPattern {
  pattern: string;
  kind: DeclarationMacroKind | 'function-reference';
}

export const BUILTIN_DECLARATION_MACROS: BuiltinMacroPattern[] = [
  // Textures
  { pattern: 'TEXTURE2D($name)', kind: 'variable' },
  { pattern: 'TEXTURE2D_X($name)', kind: 'variable' },
  { pattern: 'TEXTURE2D_ARRAY($name)', kind: 'variable' },
  { pattern: 'TEXTURE3D($name)', kind: 'variable' },
  { pattern: 'TEXTURECUBE($name)', kind: 'variable' },
  { pattern: 'TEXTURECUBE_ARRAY($name)', kind: 'variable' },
  // Samplers
  { pattern: 'SAMPLER($name)', kind: 'variable' },
  { pattern: 'SAMPLER_CMP($name)', kind: 'variable' },
  // Legacy Unity declarations
  { pattern: 'UNITY_DECLARE_TEX2D($name)', kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEX2D_NOSAMPLER($name)', kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEX2DARRAY($name)', kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEXCUBE($name)', kind: 'variable' },
  // Instancing
  { pattern: 'UNITY_DEFINE_INSTANCED_PROP(_, $name)', kind: 'variable' },
  // cbuffer
  { pattern: 'CBUFFER_START($name)', kind: 'cbuffer' },
];

export const BUILTIN_REFERENCE_MACROS: BuiltinMacroPattern[] = [
  { pattern: '#pragma vertex $func', kind: 'function-reference' },
  { pattern: '#pragma fragment $func', kind: 'function-reference' },
  { pattern: '#pragma geometry $func', kind: 'function-reference' },
  { pattern: '#pragma hull $func', kind: 'function-reference' },
  { pattern: '#pragma domain $func', kind: 'function-reference' },
  { pattern: '#pragma kernel $func', kind: 'function-reference' },
];
