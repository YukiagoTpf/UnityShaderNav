import type { DeclarationMacroKind } from '@unity-shader-nav/shared';

export type BuiltinDeclaredTypeRecipe =
  | { readonly kind: 'argument'; readonly argumentIndex: number }
  | { readonly kind: 'generic'; readonly baseType: string; readonly argumentIndex: number };

export interface BuiltinMacroPattern {
  pattern: string;
  kind: DeclarationMacroKind | 'function-reference';
  declaredType?: string;
  declaredTypeRecipe?: BuiltinDeclaredTypeRecipe;
}

function genericVariable(pattern: string, baseType: string): BuiltinMacroPattern {
  return {
    pattern,
    kind: 'variable',
    declaredTypeRecipe: { kind: 'generic', baseType, argumentIndex: 0 },
  };
}

function argumentTypedVariable(pattern: string): BuiltinMacroPattern {
  return {
    pattern,
    kind: 'variable',
    declaredTypeRecipe: { kind: 'argument', argumentIndex: 0 },
  };
}

export const BUILTIN_DECLARATION_MACROS: BuiltinMacroPattern[] = [
  // Textures
  { pattern: 'TEXTURE2D($name)', kind: 'variable', declaredType: 'Texture2D' },
  { pattern: 'TEXTURE2D_HALF($name)', kind: 'variable', declaredType: 'Texture2D' },
  { pattern: 'TEXTURE2D_FLOAT($name)', kind: 'variable', declaredType: 'Texture2D' },
  { pattern: 'TEXTURE2D_X($name)', kind: 'variable' },
  { pattern: 'TEXTURE2D_X_HALF($name)', kind: 'variable' },
  { pattern: 'TEXTURE2D_X_FLOAT($name)', kind: 'variable' },
  { pattern: 'TEXTURE2D_ARRAY($name)', kind: 'variable', declaredType: 'Texture2DArray' },
  { pattern: 'TEXTURE2D_ARRAY_HALF($name)', kind: 'variable', declaredType: 'Texture2DArray' },
  { pattern: 'TEXTURE2D_ARRAY_FLOAT($name)', kind: 'variable', declaredType: 'Texture2DArray' },
  { pattern: 'TEXTURE3D($name)', kind: 'variable', declaredType: 'Texture3D' },
  { pattern: 'TEXTURE3D_HALF($name)', kind: 'variable', declaredType: 'Texture3D' },
  { pattern: 'TEXTURE3D_FLOAT($name)', kind: 'variable', declaredType: 'Texture3D' },
  { pattern: 'TEXTURECUBE($name)', kind: 'variable', declaredType: 'TextureCube' },
  { pattern: 'TEXTURECUBE_HALF($name)', kind: 'variable', declaredType: 'TextureCube' },
  { pattern: 'TEXTURECUBE_FLOAT($name)', kind: 'variable', declaredType: 'TextureCube' },
  { pattern: 'TEXTURECUBE_ARRAY($name)', kind: 'variable', declaredType: 'TextureCubeArray' },
  { pattern: 'TEXTURECUBE_ARRAY_HALF($name)', kind: 'variable', declaredType: 'TextureCubeArray' },
  { pattern: 'TEXTURECUBE_ARRAY_FLOAT($name)', kind: 'variable', declaredType: 'TextureCubeArray' },
  { pattern: 'TEXTURE2D_SHADOW($name)', kind: 'variable', declaredType: 'Texture2D' },
  { pattern: 'TEXTURE2D_ARRAY_SHADOW($name)', kind: 'variable', declaredType: 'Texture2DArray' },
  { pattern: 'TEXTURECUBE_SHADOW($name)', kind: 'variable', declaredType: 'TextureCube' },
  { pattern: 'TEXTURECUBE_ARRAY_SHADOW($name)', kind: 'variable', declaredType: 'TextureCubeArray' },
  genericVariable('TYPED_TEXTURE2D(_, $name)', 'Texture2D'),
  genericVariable('TYPED_TEXTURE2D_ARRAY(_, $name)', 'Texture2DArray'),
  genericVariable('TYPED_TEXTURE3D(_, $name)', 'Texture3D'),
  genericVariable('RW_TEXTURE2D(_, $name)', 'RWTexture2D'),
  { pattern: 'RW_TEXTURE2D_X(_, $name)', kind: 'variable' },
  genericVariable('RW_TEXTURE2D_ARRAY(_, $name)', 'RWTexture2DArray'),
  genericVariable('RW_TEXTURE3D(_, $name)', 'RWTexture3D'),
  // Samplers
  { pattern: 'SAMPLER($name)', kind: 'variable', declaredType: 'SamplerState' },
  { pattern: 'SAMPLER_CMP($name)', kind: 'variable', declaredType: 'SamplerComparisonState' },
  // Legacy Unity declarations
  { pattern: 'UNITY_DECLARE_TEX2D($name)', kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEX2D_NOSAMPLER($name)', kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEX2DARRAY($name)', kind: 'variable' },
  { pattern: 'UNITY_DECLARE_TEXCUBE($name)', kind: 'variable' },
  // Instancing
  { pattern: 'UNITY_INSTANCING_BUFFER_START($name)', kind: 'cbuffer' },
  { pattern: 'UNITY_INSTANCING_CBUFFER_SCOPE_BEGIN($name)', kind: 'cbuffer' },
  { pattern: 'UNITY_DOTS_INSTANCING_START($name)', kind: 'cbuffer' },
  argumentTypedVariable('UNITY_DEFINE_INSTANCED_PROP(_, $name)'),
  argumentTypedVariable('UNITY_DOTS_INSTANCED_PROP(_, $name)'),
  argumentTypedVariable('UNITY_DOTS_INSTANCED_PROP_OVERRIDE_DISABLED(_, $name)'),
  argumentTypedVariable('UNITY_DOTS_INSTANCED_PROP_OVERRIDE_SUPPORTED(_, $name)'),
  argumentTypedVariable('UNITY_DOTS_INSTANCED_PROP_OVERRIDE_REQUIRED(_, $name)'),
  // cbuffer
  { pattern: 'CBUFFER_START($name)', kind: 'cbuffer' },
];

export const BUILTIN_REFERENCE_MACROS: BuiltinMacroPattern[] = [
  { pattern: '#pragma vertex $func', kind: 'function-reference' },
  { pattern: '#pragma fragment $func', kind: 'function-reference' },
  { pattern: '#pragma geometry $func', kind: 'function-reference' },
  { pattern: '#pragma hull $func', kind: 'function-reference' },
  { pattern: '#pragma domain $func', kind: 'function-reference' },
  { pattern: '#pragma surface $func', kind: 'function-reference' },
  { pattern: '#pragma kernel $func', kind: 'function-reference' },
];

export const BUILTIN_SENTINEL_MACROS = [
  'CBUFFER_END',
  'UNITY_INSTANCING_BUFFER_START',
  'UNITY_INSTANCING_BUFFER_END',
  'UNITY_INSTANCING_CBUFFER_SCOPE_BEGIN',
  'UNITY_INSTANCING_CBUFFER_SCOPE_END',
  'UNITY_DOTS_INSTANCING_START',
  'UNITY_DOTS_INSTANCING_END',
] as const;
