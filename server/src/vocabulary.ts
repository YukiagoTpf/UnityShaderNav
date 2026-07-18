import type { ShaderLabPropertyType } from '@unity-shader-nav/shared';

export type BuiltinCategory =
  | 'hlsl'
  | 'unitycg'
  | 'srp-core'
  | 'urp'
  | 'hdrp'
  | 'shaderlab'
  | 'semantic';

export interface BuiltinEntry {
  readonly name: string;
  readonly kind:
    | 'function'
    | 'keyword'
    | 'semantic'
    | 'state'
    | 'macro'
    | 'type'
    | 'variable'
    | 'structMember';
  readonly category: BuiltinCategory;
  readonly roles?: readonly BuiltinRole[];
  readonly detail?: string;
  readonly documentation?: string;
  readonly quickDocumentation?: BuiltinQuickDocumentation;
  readonly insertText?: string;
  readonly declaredType?: string;
  readonly parentType?: string;
  readonly typeShape?: BuiltinTypeShape;
  readonly returnType?: string;
  readonly parameters?: readonly {
    readonly name: string;
    readonly type: string;
    readonly documentation?: string;
  }[];
}

export type BuiltinTypeShape =
  | {
    readonly kind: 'vector';
    readonly elementType: string;
    readonly size: 1 | 2 | 3 | 4;
  }
  | {
    readonly kind: 'matrix';
    readonly elementType: string;
    readonly rows: 1 | 2 | 3 | 4;
    readonly columns: 1 | 2 | 3 | 4;
  }
  | {
    readonly kind: 'texture';
    readonly dimensions: 1 | 2 | 3 | 'cube';
    readonly array?: boolean;
    readonly writable?: boolean;
  };

export interface BuiltinQuickDocumentation {
  readonly summary: string;
  readonly source: {
    readonly label: string;
    readonly url: string;
  };
  readonly scope:
    | {
      readonly kind: 'unity';
      readonly label: string;
      readonly supportedEditorVersions: readonly string[];
    }
    | { readonly kind: 'hlsl'; readonly label: string }
    | {
      readonly kind: 'package';
      readonly label: string;
      readonly packageName: string;
      readonly supportedMajorVersions: readonly number[];
    };
}

export type BuiltinRole =
  | 'shaderLabKeyword'
  | 'shaderLabRenderState'
  | 'shaderLabStateValueContext'
  | 'shaderLabStateValue'
  | 'shaderLabPropertyType'
  | 'shaderLabPropertyAttribute';

export type BuiltinContext =
  | 'hlsl'
  | 'semantic'
  | 'shaderLab'
  | 'shaderLabStateValue';

export type BuiltinLexicalContext = 'hlsl' | 'shaderLab' | 'shaderLabProperty';
export type BuiltinLexicalRole =
  | 'keyword'
  | 'function'
  | 'macro'
  | 'type'
  | 'semantic'
  | 'variable';

const shaderLabStateDetail = 'ShaderLab render state';
const shaderLabValueDetail = 'ShaderLab state value';
const shaderLabPropertyTypeDetail = 'ShaderLab Property type';

function shaderLabKeyword(
  name: string,
  detail = 'ShaderLab keyword',
  quickDocumentation?: BuiltinQuickDocumentation,
): BuiltinEntry {
  return {
    name,
    kind: 'keyword',
    category: 'shaderlab',
    roles: ['shaderLabKeyword'],
    detail,
    quickDocumentation,
  };
}

function shaderLabStateKeyword(name: string): BuiltinEntry {
  return {
    name,
    kind: 'state',
    category: 'shaderlab',
    roles: ['shaderLabKeyword'],
    detail: shaderLabStateDetail,
  };
}

function shaderLabRenderState(
  name: string,
  acceptsValue = false,
  quickDocumentation?: BuiltinQuickDocumentation,
): BuiltinEntry {
  return {
    name,
    kind: 'state',
    category: 'shaderlab',
    roles: acceptsValue
      ? ['shaderLabRenderState', 'shaderLabStateValueContext']
      : ['shaderLabRenderState'],
    detail: shaderLabStateDetail,
    quickDocumentation,
  };
}

function shaderLabStateValue(name: string): BuiltinEntry {
  return {
    name,
    kind: 'keyword',
    category: 'shaderlab',
    roles: ['shaderLabStateValue'],
    detail: shaderLabValueDetail,
  };
}

function shaderLabPropertyType(name: ShaderLabPropertyType): BuiltinEntry {
  return {
    name,
    kind: 'type',
    category: 'shaderlab',
    roles: ['shaderLabPropertyType'],
    detail: shaderLabPropertyTypeDetail,
    quickDocumentation: propertyTypeDocumentation(name),
  };
}

function shaderLabPropertyAttribute(
  name: string,
  summary: string,
): BuiltinEntry {
  return {
    name,
    kind: 'keyword',
    category: 'shaderlab',
    roles: ['shaderLabPropertyAttribute'],
    detail: 'ShaderLab Property attribute',
    quickDocumentation: unityDocumentation(
      summary,
      'Properties block reference',
      'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-Properties.html',
    ),
  };
}

function unityDocumentation(
  summary: string,
  label: string,
  url: string,
): BuiltinQuickDocumentation {
  return {
    summary,
    source: { label, url },
    scope: {
      kind: 'unity',
      label: 'Unity 2022.3 manual',
      supportedEditorVersions: ['2022.3'],
    },
  };
}

function packageDocumentation(
  summary: string,
  label: string,
  url: string,
  packageName: string,
  scopeLabel: string,
  supportedMajorVersions: readonly number[],
): BuiltinQuickDocumentation {
  return {
    summary,
    source: { label, url },
    scope: {
      kind: 'package',
      label: scopeLabel,
      packageName,
      supportedMajorVersions,
    },
  };
}

function propertyTypeDocumentation(name: ShaderLabPropertyType): BuiltinQuickDocumentation {
  const summaries: Record<ShaderLabPropertyType, string> = {
    '2D': 'Declares a 2D texture Material property.',
    '2DArray': 'Declares a 2D texture-array Material property.',
    '3D': 'Declares a 3D texture Material property.',
    Cube: 'Declares a cubemap Material property.',
    CubeArray: 'Declares a cubemap-array Material property.',
    Color: 'Declares a color picker backed by a four-component value.',
    Vector: 'Declares a four-component vector Material property.',
    Float: 'Declares a floating-point Material property.',
    Range: 'Declares a floating-point slider with inclusive bounds.',
    Int: 'Declares the legacy float-backed integer-looking Property type.',
    Integer: 'Declares a Material property backed by a real integer.',
  };
  return unityDocumentation(
    summaries[name],
    'Properties block reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-Properties.html',
  );
}

const SHADERLAB_PROPERTY_TYPE_NAMES = {
  '2D': true,
  '2DArray': true,
  '3D': true,
  Cube: true,
  CubeArray: true,
  Color: true,
  Vector: true,
  Float: true,
  Range: true,
  Int: true,
  Integer: true,
} satisfies Record<ShaderLabPropertyType, true>;

function shaderLabPropertyTypes(): BuiltinEntry[] {
  return (Object.keys(SHADERLAB_PROPERTY_TYPE_NAMES) as ShaderLabPropertyType[])
    .map(shaderLabPropertyType);
}

type BuiltinParameter = NonNullable<BuiltinEntry['parameters']>[number];

function hlslFunction(
  name: string,
  returnType: string,
  parameters: readonly BuiltinParameter[],
  documentation: string,
): BuiltinEntry {
  return {
    name,
    kind: 'function',
    category: 'hlsl',
    returnType,
    parameters,
    documentation,
  };
}

function hlslComponentShapeOverloads(
  name: string,
  returnComponentType: string,
  inputComponentTypes: readonly string[],
  documentation: string,
): BuiltinEntry[] {
  return inputComponentTypes.map((inputComponentType) => hlslFunction(
    name,
    `${returnComponentType}<x>`,
    [{ type: `${inputComponentType}<x>`, name: 'x' }],
    documentation,
  ));
}

function hlslMatchingComponentShapeOverloads(
  name: string,
  componentTypes: readonly string[],
  documentation: string,
): BuiltinEntry[] {
  return componentTypes.flatMap((componentType) => hlslComponentShapeOverloads(
    name,
    componentType,
    [componentType],
    documentation,
  ));
}

const VECTOR_SIZES = [1, 2, 3, 4] as const;
const MATRIX_DIMENSIONS = [1, 2, 3, 4] as const;

function numericTypeFamily(
  elementType: string,
  category: BuiltinCategory,
  scopeLabel: string,
): BuiltinEntry[] {
  return [
    {
      name: elementType,
      kind: 'type',
      category,
      detail: `${scopeLabel} scalar type`,
      documentation: `${scopeLabel} scalar numeric type ${elementType}.`,
    },
    ...VECTOR_SIZES.map((size): BuiltinEntry => ({
      name: `${elementType}${size}`,
      kind: 'type',
      category,
      typeShape: { kind: 'vector', elementType, size },
      detail: `${scopeLabel} vector type`,
      documentation: `${size}-component ${elementType} vector.`,
    })),
  ];
}

function matrixTypeFamily(
  elementType: string,
  category: BuiltinCategory,
  scopeLabel: string,
): BuiltinEntry[] {
  const entries: BuiltinEntry[] = [];
  for (const rows of MATRIX_DIMENSIONS) {
    for (const columns of MATRIX_DIMENSIONS) {
      entries.push({
        name: `${elementType}${rows}x${columns}`,
        kind: 'type',
        category,
        typeShape: { kind: 'matrix', elementType, rows, columns },
        detail: `${scopeLabel} matrix type`,
        documentation: `${rows}x${columns} ${elementType} matrix.`,
      });
    }
  }
  return entries;
}

function hlslKeywords(
  names: readonly string[],
  detail: string,
): BuiltinEntry[] {
  return names.map((name) => ({
    name,
    kind: 'keyword',
    category: 'hlsl',
    detail,
  }));
}

const HLSL_KEYWORDS = [
  ...hlslKeywords(
    ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'discard'],
    'HLSL control-flow keyword',
  ),
  ...hlslKeywords(
    ['in', 'out', 'inout'],
    'HLSL parameter modifier',
  ),
  ...hlslKeywords(
    ['const', 'static', 'uniform', 'register', 'packoffset', 'groupshared', 'precise'],
    'HLSL storage or declaration qualifier',
  ),
  ...hlslKeywords(
    ['linear', 'centroid', 'nointerpolation', 'noperspective', 'sample'],
    'HLSL interpolation modifier',
  ),
  ...hlslKeywords(
    ['numthreads'],
    'HLSL shader attribute',
  ),
] satisfies readonly BuiltinEntry[];

function unityGlobal(
  name: string,
  declaredType: string,
  documentation: string,
): BuiltinEntry {
  return {
    name,
    kind: 'variable',
    category: 'unitycg',
    declaredType,
    detail: 'Unity built-in global',
    documentation,
  };
}

function unityMacros(
  names: readonly string[],
  detail: string,
): BuiltinEntry[] {
  return names.map((name) => ({
    name,
    kind: 'macro',
    category: 'unitycg',
    detail,
  }));
}

const UNITY_BUILTIN_GLOBALS = [
  unityGlobal('_ScreenParams', 'float4', 'Screen dimensions and related reciprocal terms.'),
  unityGlobal('_ProjectionParams', 'float4', 'Projection flip sign, near plane, far plane, and reciprocal far plane.'),
  unityGlobal('_ZBufferParams', 'float4', 'Parameters used to linearize values from the depth buffer.'),
  unityGlobal('_WorldSpaceLightPos0', 'float4', 'Position or direction of the primary light in world space.'),
  unityGlobal('_LightColor0', 'fixed4', 'Color of the primary light.'),
  unityGlobal('unity_MatrixVP', 'float4x4', 'Current view-projection matrix.'),
  unityGlobal('unity_ObjectToWorld', 'float4x4', 'Object-to-world transformation matrix.'),
  unityGlobal('unity_WorldToObject', 'float4x4', 'World-to-object transformation matrix.'),
  unityGlobal('_WorldSpaceCameraPos', 'float3', 'World-space position of the active camera.'),
  unityGlobal('_Time', 'float4', 'Time values packed as (t/20, t, t*2, t*3).'),
  unityGlobal('_SinTime', 'float4', 'Sine of time packed as (t/8, t/4, t/2, t).'),
  unityGlobal('_CosTime', 'float4', 'Cosine of time packed as (t/8, t/4, t/2, t).'),
] satisfies readonly BuiltinEntry[];

const UNITY_BUILTIN_MACROS = [
  ...unityMacros(
    ['UNITY_MATRIX_MVP', 'UNITY_MATRIX_M', 'UNITY_MATRIX_V', 'UNITY_MATRIX_P', 'UNITY_MATRIX_VP'],
    'Unity matrix macro',
  ),
  ...unityMacros(
    ['UNITY_MATRIX_I_M', 'UNITY_MATRIX_I_V', 'UNITY_MATRIX_I_P', 'UNITY_MATRIX_I_VP'],
    'Unity inverse matrix macro',
  ),
  ...unityMacros(
    ['UNITY_BRANCH', 'UNITY_FLATTEN', 'UNITY_UNROLL', 'UNITY_UNROLLX', 'UNITY_LOOP'],
    'Unity flow-control attribute macro',
  ),
  ...unityMacros(['UNITY_PI'], 'Unity numeric constant macro'),
  ...unityMacros(['UNITY_INITIALIZE_OUTPUT'], 'Unity output initialization macro'),
] satisfies readonly BuiltinEntry[];

function urpFunction(
  name: string,
  returnType: string,
  parameters: readonly BuiltinParameter[],
  documentation: string,
): BuiltinEntry {
  return {
    name,
    kind: 'function',
    category: 'urp',
    returnType,
    parameters,
    documentation,
  };
}

const URP_ADDITIONS = [
  { name: 'SAMPLE_TEXTURE2D_X', kind: 'macro', category: 'urp', detail: 'URP texture sampling macro' },
  { name: 'SAMPLE_TEXTURE2D_X_LOD', kind: 'macro', category: 'urp', detail: 'URP texture sampling macro' },
  { name: 'SAMPLE_GI', kind: 'macro', category: 'urp', detail: 'URP global illumination macro' },
  { name: 'InputData', kind: 'type', category: 'urp', detail: 'URP fragment input structure' },
  { name: 'SurfaceData', kind: 'type', category: 'urp', detail: 'URP material surface structure' },
  urpFunction(
    'GetShadowCoord',
    'float4',
    [{ type: 'VertexPositionInputs', name: 'positionInputs' }],
    'Returns the shadow-map coordinate derived from URP vertex position inputs.',
  ),
  urpFunction(
    'SampleSH',
    'half3',
    [{ type: 'half3', name: 'normalWS' }],
    'Samples spherical-harmonics ambient lighting for a world-space normal.',
  ),
  urpFunction(
    'MixFog',
    'half3',
    [{ type: 'half3', name: 'fragmentColor' }, { type: 'float', name: 'fogFactor' }],
    'Blends a fragment color with the active URP fog color.',
  ),
] satisfies readonly BuiltinEntry[];

interface TextureObjectDescriptor {
  readonly name: string;
  readonly dimensions: 1 | 2 | 3 | 'cube';
  readonly array?: boolean;
  readonly coordinateType: string;
  readonly gradientType: string;
  readonly offsetType?: string;
  readonly loadLocationType?: string;
  readonly dimensionNames: readonly string[];
  readonly floatNumberOfLevelsType?: 'float' | 'uint';
  readonly supportsComparison?: boolean;
  readonly supportsGather?: boolean;
}

function textureMethod(
  parentType: string,
  name: string,
  returnType: string,
  parameters: readonly BuiltinParameter[],
  documentation: string,
): BuiltinEntry {
  return {
    name,
    kind: 'function',
    category: 'hlsl',
    parentType,
    returnType,
    parameters,
    documentation,
  };
}

function textureMethodWithOptionalOffset(
  descriptor: TextureObjectDescriptor,
  name: string,
  returnType: string,
  parameters: readonly BuiltinParameter[],
  documentation: string,
): BuiltinEntry[] {
  const entries = [textureMethod(
    descriptor.name,
    name,
    returnType,
    parameters,
    documentation,
  )];
  if (descriptor.offsetType) {
    entries.push(textureMethod(
      descriptor.name,
      name,
      returnType,
      [...parameters, { type: descriptor.offsetType, name: 'offset' }],
      `${documentation} Applies a constant texel offset.`,
    ));
  }
  return entries;
}

function textureObjectEntries(
  descriptor: TextureObjectDescriptor,
): BuiltinEntry[] {
  const samplerAndLocation: readonly BuiltinParameter[] = [
    { type: 'SamplerState', name: 'samplerState' },
    { type: descriptor.coordinateType, name: 'location' },
  ];
  const entries: BuiltinEntry[] = [{
    name: descriptor.name,
    kind: 'type',
    category: 'hlsl',
    typeShape: descriptor.array
      ? { kind: 'texture', dimensions: descriptor.dimensions, array: true }
      : { kind: 'texture', dimensions: descriptor.dimensions },
    detail: 'HLSL texture-object type',
    documentation: `${descriptor.name} texture resource.`,
  }];

  entries.push(...textureMethodWithOptionalOffset(
    descriptor,
    'Sample',
    'T',
    samplerAndLocation,
    'Samples the texture using implicit derivatives.',
  ));
  entries.push(...textureMethodWithOptionalOffset(
    descriptor,
    'SampleLevel',
    'T',
    [...samplerAndLocation, { type: 'float', name: 'lod' }],
    'Samples the texture at an explicit mip level.',
  ));
  entries.push(...textureMethodWithOptionalOffset(
    descriptor,
    'SampleBias',
    'T',
    [...samplerAndLocation, { type: 'float', name: 'bias' }],
    'Samples the texture after applying a mip-level bias.',
  ));
  entries.push(...textureMethodWithOptionalOffset(
    descriptor,
    'SampleGrad',
    'T',
    [
      ...samplerAndLocation,
      { type: descriptor.gradientType, name: 'ddx' },
      { type: descriptor.gradientType, name: 'ddy' },
    ],
    'Samples the texture using explicit coordinate gradients.',
  ));

  if (descriptor.supportsComparison) {
    entries.push(...textureMethodWithOptionalOffset(
      descriptor,
      'SampleCmp',
      'float',
      [
        { type: 'SamplerComparisonState', name: 'samplerState' },
        { type: descriptor.coordinateType, name: 'location' },
        { type: 'float', name: 'compareValue' },
      ],
      'Samples the texture and compares its first component with a reference value.',
    ));
  }

  if (descriptor.loadLocationType) {
    entries.push(...textureMethodWithOptionalOffset(
      descriptor,
      'Load',
      'T',
      [{ type: descriptor.loadLocationType, name: 'location' }],
      'Reads a texel without filtering.',
    ));
  }

  if (descriptor.supportsGather) {
    for (const name of ['Gather', 'GatherRed', 'GatherGreen', 'GatherBlue', 'GatherAlpha']) {
      entries.push(...textureMethodWithOptionalOffset(
        descriptor,
        name,
        'T4',
        samplerAndLocation,
        `Gathers four ${name === 'Gather' ? 'red' : name.slice('Gather'.length).toLowerCase()} components from neighboring texels.`,
      ));
    }
  }

  for (const componentType of ['uint', 'float'] as const) {
    const dimensions = descriptor.dimensionNames.map((name): BuiltinParameter => ({
      type: `out ${componentType}`,
      name,
    }));
    const numberOfLevelsType = componentType === 'float'
      ? descriptor.floatNumberOfLevelsType ?? 'float'
      : 'uint';
    entries.push(textureMethod(
      descriptor.name,
      'GetDimensions',
      'void',
      dimensions,
      'Returns dimensions of the largest mip level.',
    ));
    entries.push(textureMethod(
      descriptor.name,
      'GetDimensions',
      'void',
      [
        { type: 'uint', name: 'mipLevel' },
        ...dimensions,
        { type: `out ${numberOfLevelsType}`, name: 'numberOfLevels' },
      ],
      'Returns dimensions and mip count for an explicit mip level.',
    ));
  }
  return entries;
}

const TEXTURE_OBJECT_ENTRIES = [
  ...textureObjectEntries({
    name: 'Texture1D',
    dimensions: 1,
    coordinateType: 'float',
    gradientType: 'float',
    offsetType: 'int',
    loadLocationType: 'int2',
    dimensionNames: ['width'],
    supportsComparison: true,
  }),
  ...textureObjectEntries({
    name: 'Texture1DArray',
    dimensions: 1,
    array: true,
    coordinateType: 'float2',
    gradientType: 'float',
    offsetType: 'int',
    loadLocationType: 'int3',
    dimensionNames: ['width', 'elements'],
    supportsComparison: true,
  }),
  ...textureObjectEntries({
    name: 'Texture2D',
    dimensions: 2,
    coordinateType: 'float2',
    gradientType: 'float2',
    offsetType: 'int2',
    loadLocationType: 'int3',
    dimensionNames: ['width', 'height'],
    supportsComparison: true,
    supportsGather: true,
  }),
  ...textureObjectEntries({
    name: 'Texture2DArray',
    dimensions: 2,
    array: true,
    coordinateType: 'float3',
    gradientType: 'float2',
    offsetType: 'int2',
    loadLocationType: 'int4',
    dimensionNames: ['width', 'height', 'elements'],
    supportsComparison: true,
    supportsGather: true,
  }),
  ...textureObjectEntries({
    name: 'Texture3D',
    dimensions: 3,
    coordinateType: 'float3',
    gradientType: 'float3',
    offsetType: 'int3',
    loadLocationType: 'int4',
    dimensionNames: ['width', 'height', 'depth'],
  }),
  ...textureObjectEntries({
    name: 'TextureCube',
    dimensions: 'cube',
    coordinateType: 'float3',
    gradientType: 'float3',
    dimensionNames: ['width', 'height'],
    floatNumberOfLevelsType: 'uint',
    supportsComparison: true,
    supportsGather: true,
  }),
  ...textureObjectEntries({
    name: 'TextureCubeArray',
    dimensions: 'cube',
    array: true,
    coordinateType: 'float4',
    gradientType: 'float3',
    dimensionNames: ['width', 'height', 'elements'],
    supportsComparison: true,
    supportsGather: true,
  }),
] satisfies readonly BuiltinEntry[];

const ADVANCED_HLSL_FUNCTIONS = [
  hlslFunction('sincos', 'void', [{ type: 'T', name: 'x' }, { type: 'out T', name: 'sine' }, { type: 'out T', name: 'cosine' }], 'Returns the sine and cosine of x through output parameters.'),
  ...hlslComponentShapeOverloads('asfloat', 'float', ['float', 'int', 'uint'], 'Reinterprets each component of x as float while preserving scalar, vector, or matrix dimensions.'),
  ...hlslComponentShapeOverloads('asint', 'int', ['float', 'uint'], 'Reinterprets each component of x as int while preserving scalar, vector, or matrix dimensions.'),
  ...hlslComponentShapeOverloads('asuint', 'uint', ['float', 'int'], 'Reinterprets each component of x as uint while preserving scalar, vector, or matrix dimensions.'),
  ...hlslComponentShapeOverloads('isnan', 'bool', ['float'], 'Tests each floating-point component of x for NaN while preserving scalar, vector, or matrix dimensions.'),
  ...hlslComponentShapeOverloads('isinf', 'bool', ['float'], 'Tests each floating-point component of x for infinity while preserving scalar, vector, or matrix dimensions.'),
  ...hlslComponentShapeOverloads('isfinite', 'bool', ['float'], 'Tests each floating-point component of x for finiteness while preserving scalar, vector, or matrix dimensions.'),
  hlslFunction('trunc', 'T', [{ type: 'T', name: 'x' }], 'Truncates the fractional part of x.'),
  hlslFunction('ldexp', 'T', [{ type: 'T', name: 'x' }, { type: 'T', name: 'exponent' }], 'Returns x multiplied by two raised to exponent.'),
  hlslFunction('frexp', 'T', [{ type: 'T', name: 'x' }, { type: 'out T', name: 'exponent' }], 'Splits x into a normalized fraction and an integral power of two.'),
  hlslFunction('modf', 'T', [{ type: 'T', name: 'x' }, { type: 'out T', name: 'integerPart' }], 'Splits x into fractional and integral parts.'),
  hlslFunction('log10', 'T', [{ type: 'T', name: 'x' }], 'Returns the base-10 logarithm of x.'),
  hlslFunction('sinh', 'T', [{ type: 'T', name: 'x' }], 'Returns the hyperbolic sine of x.'),
  hlslFunction('cosh', 'T', [{ type: 'T', name: 'x' }], 'Returns the hyperbolic cosine of x.'),
  hlslFunction('tanh', 'T', [{ type: 'T', name: 'x' }], 'Returns the hyperbolic tangent of x.'),
  ...hlslMatchingComponentShapeOverloads('reversebits', ['uint'], 'Reverses the order of bits in each component of an unsigned integer scalar or vector.'),
  ...hlslMatchingComponentShapeOverloads('firstbitlow', ['int', 'uint'], 'Returns the lowest set-bit position per component of a signed or unsigned integer scalar or vector.'),
  ...hlslMatchingComponentShapeOverloads('firstbithigh', ['int', 'uint'], 'Returns the highest matching-bit position per component of a signed or unsigned integer scalar or vector.'),
  hlslFunction('msad4', 'uint4', [{ type: 'uint', name: 'reference' }, { type: 'uint2', name: 'source' }, { type: 'uint4', name: 'accumulator' }], 'Computes four masked sums of absolute differences.'),
  hlslFunction('WaveIsFirstLane', 'bool', [], 'Returns whether the current lane is the first active lane.'),
  hlslFunction('WaveGetLaneCount', 'uint', [], 'Returns the number of lanes in the current wave.'),
  hlslFunction('WaveGetLaneIndex', 'uint', [], 'Returns the current lane index.'),
  hlslFunction('WaveActiveAnyTrue', 'bool', [{ type: 'bool', name: 'expression' }], 'Returns whether the expression is true in any active lane.'),
  hlslFunction('WaveActiveAllTrue', 'bool', [{ type: 'bool', name: 'expression' }], 'Returns whether the expression is true in every active lane.'),
  hlslFunction('WaveActiveBallot', 'uint4', [{ type: 'bool', name: 'expression' }], 'Returns a bit mask of active lanes where expression is true.'),
  hlslFunction('WaveReadLaneAt', 'T', [{ type: 'T', name: 'value' }, { type: 'uint', name: 'laneIndex' }], 'Reads value from a selected lane.'),
  hlslFunction('WaveReadLaneFirst', 'T', [{ type: 'T', name: 'value' }], 'Reads value from the first active lane.'),
  hlslFunction('WaveActiveAllEqual', 'bool', [{ type: 'T', name: 'value' }], 'Tests whether value is equal in every active lane.'),
  hlslFunction('WaveActiveCountBits', 'uint', [{ type: 'bool', name: 'expression' }], 'Counts active lanes where expression is true.'),
  hlslFunction('WavePrefixCountBits', 'uint', [{ type: 'bool', name: 'expression' }], 'Counts preceding active lanes where expression is true.'),
  hlslFunction('WaveActiveSum', 'T', [{ type: 'T', name: 'value' }], 'Returns the sum of value across active lanes.'),
  hlslFunction('WaveActiveProduct', 'T', [{ type: 'T', name: 'value' }], 'Returns the product of value across active lanes.'),
  hlslFunction('WaveActiveBitAnd', 'T', [{ type: 'T', name: 'value' }], 'Returns the bitwise AND of value across active lanes.'),
  hlslFunction('WaveActiveBitOr', 'T', [{ type: 'T', name: 'value' }], 'Returns the bitwise OR of value across active lanes.'),
  hlslFunction('WaveActiveBitXor', 'T', [{ type: 'T', name: 'value' }], 'Returns the bitwise XOR of value across active lanes.'),
  hlslFunction('WaveActiveMin', 'T', [{ type: 'T', name: 'value' }], 'Returns the minimum value across active lanes.'),
  hlslFunction('WaveActiveMax', 'T', [{ type: 'T', name: 'value' }], 'Returns the maximum value across active lanes.'),
  hlslFunction('WavePrefixSum', 'T', [{ type: 'T', name: 'value' }], 'Returns the sum of value in preceding active lanes.'),
  hlslFunction('WavePrefixProduct', 'T', [{ type: 'T', name: 'value' }], 'Returns the product of value in preceding active lanes.'),
  hlslFunction('WaveMatch', 'uint4', [{ type: 'T', name: 'value' }], 'Returns a lane mask for active lanes whose value matches the current lane.'),
  ...['Sum', 'Product', 'BitAnd', 'BitOr', 'BitXor'].map((operation) => hlslFunction(
    `WaveMultiPrefix${operation}`,
    'T',
    [{ type: 'T', name: 'value' }, { type: 'uint4', name: 'mask' }],
    `Returns the ${operation.toLowerCase()} prefix within the lanes selected by mask.`,
  )),
  hlslFunction('QuadReadAcrossX', 'T', [{ type: 'T', name: 'value' }], 'Reads value from the horizontally adjacent lane in a quad.'),
  hlslFunction('QuadReadAcrossY', 'T', [{ type: 'T', name: 'value' }], 'Reads value from the vertically adjacent lane in a quad.'),
  hlslFunction('QuadReadAcrossDiagonal', 'T', [{ type: 'T', name: 'value' }], 'Reads value from the diagonally adjacent lane in a quad.'),
  hlslFunction('QuadReadLaneAt', 'T', [{ type: 'T', name: 'value' }, { type: 'uint', name: 'quadLane' }], 'Reads value from a selected lane in a quad.'),
  hlslFunction('QuadAny', 'bool', [{ type: 'bool', name: 'expression' }], 'Returns whether expression is true in any lane of a quad.'),
  hlslFunction('QuadAll', 'bool', [{ type: 'bool', name: 'expression' }], 'Returns whether expression is true in every lane of a quad.'),
] satisfies readonly BuiltinEntry[];

const BUILTIN_ENTRIES = [
  ...numericTypeFamily('float', 'hlsl', 'HLSL'),
  ...numericTypeFamily('half', 'hlsl', 'HLSL'),
  ...numericTypeFamily('fixed', 'unitycg', 'Unity shader'),
  ...numericTypeFamily('double', 'hlsl', 'HLSL'),
  ...numericTypeFamily('min16float', 'hlsl', 'HLSL minimum-precision'),
  ...numericTypeFamily('min10float', 'hlsl', 'HLSL minimum-precision'),
  ...numericTypeFamily('min16int', 'hlsl', 'HLSL minimum-precision'),
  ...numericTypeFamily('min12int', 'hlsl', 'HLSL minimum-precision'),
  ...numericTypeFamily('min16uint', 'hlsl', 'HLSL minimum-precision'),
  ...numericTypeFamily('real', 'urp', 'SRP'),
  {
    name: 'normalize',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [{ type: 'T', name: 'x' }],
    documentation: 'Returns x scaled to unit length.',
  },
  {
    name: 'dot',
    kind: 'function',
    category: 'hlsl',
    returnType: 'scalar',
    parameters: [
      { type: 'T', name: 'x' },
      { type: 'T', name: 'y' },
    ],
    documentation: 'Returns the dot product of x and y.',
  },
  {
    name: 'cross',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [
      { type: 'T', name: 'x' },
      { type: 'T', name: 'y' },
    ],
    documentation: 'Returns the cross product of two 3D vectors.',
  },
  {
    name: 'lerp',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [
      { type: 'T', name: 'x' },
      { type: 'T', name: 'y' },
      { type: 'T', name: 's' },
    ],
    documentation: 'Linearly interpolates between x and y by s.',
  },
  {
    name: 'saturate',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [{ type: 'T', name: 'x' }],
    documentation: 'Clamps x to the 0 to 1 range.',
  },
  {
    name: 'mul',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [
      { type: 'T', name: 'x' },
      { type: 'T', name: 'y' },
    ],
    documentation: 'Performs matrix and vector multiplication.',
  },
  {
    name: 'clamp',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [
      { type: 'T', name: 'x' },
      { type: 'T', name: 'minValue' },
      { type: 'T', name: 'maxValue' },
    ],
    documentation: 'Clamps x to the supplied range.',
  },
  {
    name: 'min',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [
      { type: 'T', name: 'x' },
      { type: 'T', name: 'y' },
    ],
    documentation: 'Returns the lesser of x and y.',
  },
  {
    name: 'max',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [
      { type: 'T', name: 'x' },
      { type: 'T', name: 'y' },
    ],
    documentation: 'Returns the greater of x and y.',
  },
  {
    name: 'pow',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [
      { type: 'T', name: 'x' },
      { type: 'T', name: 'y' },
    ],
    documentation: 'Returns x raised to the power y.',
  },
  {
    name: 'sin',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [{ type: 'T', name: 'x' }],
    documentation: 'Returns the sine of x.',
  },
  {
    name: 'cos',
    kind: 'function',
    category: 'hlsl',
    returnType: 'T',
    parameters: [{ type: 'T', name: 'x' }],
    documentation: 'Returns the cosine of x.',
  },
  {
    name: 'tex2D',
    kind: 'function',
    category: 'hlsl',
    returnType: 'float4',
    parameters: [
      { type: 'sampler2D', name: 'sampler' },
      { type: 'float2', name: 'uv' },
    ],
    documentation: 'Samples a texture using a sampler and UV coordinate.',
  },
  // === HLSL math intrinsics ===
  { name: 'abs', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the absolute value of x.' },
  { name: 'sign', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns -1, 0, or 1 indicating the sign of x.' },
  { name: 'floor', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the largest integer not greater than x.' },
  { name: 'ceil', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the smallest integer not less than x.' },
  { name: 'round', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Rounds x to the nearest integer.' },
  { name: 'frac', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the fractional part of x.' },
  { name: 'fmod', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }, { type: 'T', name: 'y' }], documentation: 'Returns the floating-point remainder of x / y.' },
  { name: 'step', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'edge' }, { type: 'T', name: 'x' }], documentation: 'Returns 1 if x >= edge, otherwise 0.' },
  { name: 'smoothstep', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'edge0' }, { type: 'T', name: 'edge1' }, { type: 'T', name: 'x' }], documentation: 'Returns a smooth Hermite interpolation between 0 and 1.' },
  { name: 'sqrt', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the square root of x.' },
  { name: 'rsqrt', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the reciprocal square root of x.' },
  { name: 'exp', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns e raised to the power x.' },
  { name: 'exp2', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns 2 raised to the power x.' },
  { name: 'log', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the natural logarithm of x.' },
  { name: 'log2', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the base-2 logarithm of x.' },
  { name: 'mad', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'a' }, { type: 'T', name: 'b' }, { type: 'T', name: 'c' }], documentation: 'Returns a * b + c using a fused multiply-add when available.' },
  { name: 'rcp', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the approximate reciprocal of x.' },
  { name: 'tan', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the tangent of x.' },
  { name: 'asin', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the arcsine of x.' },
  { name: 'acos', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the arccosine of x.' },
  { name: 'atan', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the arctangent of x.' },
  { name: 'atan2', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'y' }, { type: 'T', name: 'x' }], documentation: 'Returns the arctangent of y / x using the signs to choose the quadrant.' },
  { name: 'radians', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'degrees' }], documentation: 'Converts degrees to radians.' },
  { name: 'degrees', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'radians' }], documentation: 'Converts radians to degrees.' },
  ...ADVANCED_HLSL_FUNCTIONS,
  // === HLSL geometry helpers ===
  { name: 'length', kind: 'function', category: 'hlsl', returnType: 'scalar', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the length of vector x.' },
  { name: 'distance', kind: 'function', category: 'hlsl', returnType: 'scalar', parameters: [{ type: 'T', name: 'x' }, { type: 'T', name: 'y' }], documentation: 'Returns the distance between vectors x and y.' },
  { name: 'reflect', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'i' }, { type: 'T', name: 'n' }], documentation: 'Returns i reflected across normal n.' },
  { name: 'refract', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'i' }, { type: 'T', name: 'n' }, { type: 'scalar', name: 'eta' }], documentation: 'Returns i refracted through the surface defined by normal n and ratio eta.' },
  { name: 'transpose', kind: 'function', category: 'hlsl', returnType: 'matrix', parameters: [{ type: 'matrix', name: 'm' }], documentation: 'Returns the transpose of matrix m.' },
  { name: 'determinant', kind: 'function', category: 'hlsl', returnType: 'scalar', parameters: [{ type: 'matrix', name: 'm' }], documentation: 'Returns the determinant of matrix m.' },
  { name: 'lit', kind: 'function', category: 'hlsl', returnType: 'float4', parameters: [{ type: 'scalar', name: 'nDotL' }, { type: 'scalar', name: 'nDotH' }, { type: 'scalar', name: 'm' }], documentation: 'Returns a lighting coefficient vector (ambient, diffuse, specular, 1).' },
  // === HLSL derivatives and per-pixel helpers ===
  { name: 'ddx', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the partial derivative of x with respect to the screen-space x coordinate.' },
  { name: 'ddy', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns the partial derivative of x with respect to the screen-space y coordinate.' },
  { name: 'ddx_fine', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Higher-precision variant of ddx.' },
  { name: 'ddy_fine', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Higher-precision variant of ddy.' },
  { name: 'fwidth', kind: 'function', category: 'hlsl', returnType: 'T', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns |ddx(x)| + |ddy(x)|.' },
  { name: 'any', kind: 'function', category: 'hlsl', returnType: 'bool', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns true if any component of x is non-zero.' },
  { name: 'all', kind: 'function', category: 'hlsl', returnType: 'bool', parameters: [{ type: 'T', name: 'x' }], documentation: 'Returns true if all components of x are non-zero.' },
  { name: 'clip', kind: 'function', category: 'hlsl', returnType: 'void', parameters: [{ type: 'T', name: 'x' }], documentation: 'Discards the current pixel if any component of x is negative.' },
  { name: 'countbits', kind: 'function', category: 'hlsl', returnType: 'uint', parameters: [{ type: 'uint', name: 'x' }], documentation: 'Returns the number of bits set in x.' },
  ...HLSL_KEYWORDS,
  // === HLSL scalar and vector types ===
  ...numericTypeFamily('int', 'hlsl', 'HLSL'),
  ...numericTypeFamily('uint', 'hlsl', 'HLSL'),
  ...numericTypeFamily('bool', 'hlsl', 'HLSL'),
  { name: 'vector', kind: 'type', category: 'hlsl', detail: 'HLSL generic vector type', documentation: 'Generic vector type written as vector<elementType, size>.' },
  { name: 'matrix', kind: 'type', category: 'hlsl', detail: 'HLSL generic matrix type', documentation: 'Generic matrix type written as matrix<elementType, rows, columns>.' },
  // === HLSL matrix types ===
  ...matrixTypeFamily('float', 'hlsl', 'HLSL'),
  ...matrixTypeFamily('half', 'hlsl', 'HLSL'),
  ...matrixTypeFamily('double', 'hlsl', 'HLSL'),
  // === HLSL resource types ===
  { name: 'sampler', kind: 'type', category: 'hlsl', detail: 'HLSL sampler type', documentation: 'Legacy sampler object.' },
  { name: 'sampler1D', kind: 'type', category: 'hlsl', detail: 'HLSL sampler type', documentation: 'Legacy one-dimensional texture sampler.' },
  { name: 'sampler2D', kind: 'type', category: 'hlsl', detail: 'HLSL sampler type', documentation: 'Legacy two-dimensional texture sampler.' },
  { name: 'sampler3D', kind: 'type', category: 'hlsl', detail: 'HLSL sampler type', documentation: 'Legacy three-dimensional texture sampler.' },
  { name: 'samplerCUBE', kind: 'type', category: 'hlsl', detail: 'HLSL sampler type', documentation: 'Legacy cube-map texture sampler.' },
  ...TEXTURE_OBJECT_ENTRIES,
  { name: 'SamplerState', kind: 'type', category: 'hlsl', detail: 'HLSL resource type', documentation: 'Standalone sampler state object.' },
  { name: 'SamplerComparisonState', kind: 'type', category: 'hlsl', detail: 'HLSL resource type', documentation: 'Sampler state object for comparison sampling.' },
  { name: 'RWTexture2D', kind: 'type', category: 'hlsl', detail: 'HLSL resource type', documentation: 'Read-write 2D texture resource for compute shaders.' },
  { name: 'StructuredBuffer', kind: 'type', category: 'hlsl', detail: 'HLSL resource type', documentation: 'Read-only buffer of user-defined structs.' },
  { name: 'RWStructuredBuffer', kind: 'type', category: 'hlsl', detail: 'HLSL resource type', documentation: 'Read-write buffer of user-defined structs.' },
  { name: 'ByteAddressBuffer', kind: 'type', category: 'hlsl', detail: 'HLSL resource type', documentation: 'Byte-addressable read-only buffer.' },
  {
    name: 'UnityObjectToClipPos',
    kind: 'function',
    category: 'unitycg',
    returnType: 'float4',
    parameters: [{ type: 'float3', name: 'pos' }],
    documentation: 'Transforms object-space position to homogeneous clip space.',
  },
  {
    name: 'TRANSFORM_TEX',
    kind: 'macro',
    category: 'unitycg',
    detail: 'UnityCG texture transform macro',
    documentation: 'Applies Unity texture scale and offset to a UV coordinate.',
  },
  {
    name: 'SAMPLE_TEXTURE2D',
    kind: 'macro',
    category: 'urp',
    detail: 'URP texture sampling macro',
    documentation: 'Samples a Texture2D with an explicit sampler and UV coordinate.',
  },
  {
    name: 'TEXTURE2D',
    kind: 'macro',
    category: 'urp',
    detail: 'URP texture declaration macro',
    documentation: 'Declares a Texture2D resource.',
  },
  {
    name: 'SAMPLER',
    kind: 'macro',
    category: 'urp',
    detail: 'URP sampler declaration macro',
    documentation: 'Declares a sampler state.',
  },
  ...URP_ADDITIONS,
  // === URP/SRP Core texture sampling and declaration macros ===
  { name: 'SAMPLE_TEXTURE2D_LOD', kind: 'macro', category: 'urp', detail: 'URP texture sampling macro', documentation: 'Samples a Texture2D at an explicit mip level.' },
  { name: 'SAMPLE_TEXTURE2D_GRAD', kind: 'macro', category: 'urp', detail: 'URP texture sampling macro', documentation: 'Samples a Texture2D using explicit derivatives.' },
  { name: 'SAMPLE_TEXTURE2D_ARRAY', kind: 'macro', category: 'urp', detail: 'URP texture sampling macro', documentation: 'Samples a Texture2DArray slice.' },
  { name: 'SAMPLE_TEXTURECUBE', kind: 'macro', category: 'urp', detail: 'URP texture sampling macro', documentation: 'Samples a TextureCube using a direction vector.' },
  { name: 'TEXTURECUBE', kind: 'macro', category: 'urp', detail: 'URP texture declaration macro', documentation: 'Declares a TextureCube resource.' },
  { name: 'TEXTURE2D_ARRAY', kind: 'macro', category: 'urp', detail: 'URP texture declaration macro', documentation: 'Declares a Texture2DArray resource.' },
  { name: 'TEXTURE2D_PARAM', kind: 'macro', category: 'urp', detail: 'URP texture parameter macro', documentation: 'Declares a Texture2D function parameter together with its sampler.' },
  { name: 'TEXTURE2D_ARGS', kind: 'macro', category: 'urp', detail: 'URP texture argument macro', documentation: 'Forwards a Texture2D and its sampler as function arguments.' },
  // === URP/SRP Core transformation helpers ===
  { name: 'TransformObjectToWorld', kind: 'function', category: 'srp-core', returnType: 'float3', parameters: [{ type: 'float3', name: 'positionOS' }], documentation: 'Transforms an object-space position to world space.' },
  {
    name: 'TransformObjectToHClip',
    kind: 'function',
    category: 'srp-core',
    returnType: 'float4',
    parameters: [{ type: 'float3', name: 'positionOS' }],
    documentation: 'Transforms an object-space position to homogeneous clip space.',
    quickDocumentation: packageDocumentation(
      'Transforms an object-space position to homogeneous clip space.',
      'SRP Core built-in shader methods',
      'https://docs.unity.cn/Packages/com.unity.render-pipelines.core@17.0/manual/built-in-shader-methods.html',
      'com.unity.render-pipelines.core',
      'SRP Core package major 17',
      [17],
    ),
  },
  { name: 'TransformWorldToHClip', kind: 'function', category: 'srp-core', returnType: 'float4', parameters: [{ type: 'float3', name: 'positionWS' }], documentation: 'Transforms a world-space position to homogeneous clip space.' },
  { name: 'TransformObjectToWorldNormal', kind: 'function', category: 'srp-core', returnType: 'float3', parameters: [{ type: 'float3', name: 'normalOS' }], documentation: 'Transforms an object-space normal to world space.' },
  { name: 'TransformWorldToView', kind: 'function', category: 'urp', returnType: 'float3', parameters: [{ type: 'float3', name: 'positionWS' }], documentation: 'Transforms a world-space position to view space.' },
  { name: 'GetWorldSpaceViewDir', kind: 'function', category: 'urp', returnType: 'float3', parameters: [{ type: 'float3', name: 'positionWS' }], documentation: 'Returns the unnormalized world-space view direction from a position.' },
  { name: 'GetWorldSpaceNormalizeViewDir', kind: 'function', category: 'urp', returnType: 'float3', parameters: [{ type: 'float3', name: 'positionWS' }], documentation: 'Returns the normalized world-space view direction from a position.' },
  {
    name: 'GetVertexPositionInputs',
    kind: 'function',
    category: 'urp',
    returnType: 'VertexPositionInputs',
    parameters: [{ type: 'float3', name: 'positionOS' }],
    documentation: 'Computes URP vertex position values (object, world, view, clip, NDC).',
    quickDocumentation: packageDocumentation(
      'Converts an object-space position to world, view, clip, and normalized-device-coordinate positions.',
      'Transform positions in a custom URP shader',
      'https://docs.unity3d.com/6000.0/Documentation/Manual/urp/use-built-in-shader-methods-transformations.html',
      'com.unity.render-pipelines.universal',
      'URP package major 17',
      [17],
    ),
  },
  { name: 'GetVertexNormalInputs', kind: 'function', category: 'urp', returnType: 'VertexNormalInputs', parameters: [{ type: 'float3', name: 'normalOS' }], documentation: 'Computes URP vertex normal/tangent/bitangent in world space.' },
  // === URP lighting helpers ===
  { name: 'GetMainLight', kind: 'function', category: 'urp', returnType: 'Light', parameters: [], documentation: 'Returns the main directional light data for the current fragment.' },
  { name: 'GetAdditionalLight', kind: 'function', category: 'urp', returnType: 'Light', parameters: [{ type: 'uint', name: 'lightIndex' }, { type: 'float3', name: 'positionWS' }], documentation: 'Returns the additional light data at the given index for a world-space position.' },
  // === Unity instancing and stereo helpers ===
  { name: 'UNITY_SETUP_INSTANCE_ID', kind: 'macro', category: 'urp', detail: 'Unity instancing macro', documentation: 'Sets up the per-instance ID for the current vertex/fragment.' },
  { name: 'UNITY_TRANSFER_INSTANCE_ID', kind: 'macro', category: 'urp', detail: 'Unity instancing macro', documentation: 'Forwards the instance ID from vertex to fragment input.' },
  { name: 'UNITY_VERTEX_INPUT_INSTANCE_ID', kind: 'macro', category: 'urp', detail: 'Unity instancing macro', documentation: 'Declares the instance ID input field on a vertex input struct.' },
  { name: 'UNITY_VERTEX_OUTPUT_STEREO', kind: 'macro', category: 'urp', detail: 'Unity stereo macro', documentation: 'Declares the stereo eye index output field on a vertex output struct.' },
  { name: 'MainLightRealtimeShadow', kind: 'function', category: 'urp', returnType: 'half', parameters: [{ type: 'float4', name: 'shadowCoord' }], documentation: 'Samples the URP realtime shadow attenuation for the main light.' },
  // === HDRP helpers (HDRP-specific; shared transformations live under SRP Core) ===
  { name: 'GetShadowFade', kind: 'function', category: 'hdrp', returnType: 'float', parameters: [{ type: 'float3', name: 'positionWS' }, { type: 'float3', name: 'cameraDirection' }], documentation: 'Returns the shadow fade factor for a position relative to the camera.' },
  { name: 'GetCurrentExposureMultiplier', kind: 'function', category: 'hdrp', returnType: 'float', parameters: [], documentation: 'Returns the current camera exposure multiplier used by HDRP shaders.' },
  { name: 'ApplyDecalToSurfaceData', kind: 'function', category: 'hdrp', returnType: 'void', parameters: [{ type: 'DecalSurfaceData', name: 'decalSurfaceData' }, { type: 'float3', name: 'vtxNormal' }, { type: 'inout SurfaceData', name: 'surfaceData' }], documentation: 'Composites an HDRP decal sample into the lit SurfaceData of the current pixel.' },
  {
    name: 'CBUFFER_START',
    kind: 'macro',
    category: 'unitycg',
    detail: 'Unity constant buffer macro',
    documentation: 'Begins a Unity shader constant buffer.',
  },
  {
    name: 'CBUFFER_END',
    kind: 'macro',
    category: 'unitycg',
    detail: 'Unity constant buffer macro',
    documentation: 'Ends a Unity shader constant buffer.',
  },
  // === UnityCG legacy sampling macros and helpers ===
  { name: 'tex2Dlod', kind: 'function', category: 'unitycg', returnType: 'float4', parameters: [{ type: 'sampler2D', name: 'sampler' }, { type: 'float4', name: 'uv_lod' }], documentation: 'Samples a 2D texture with an explicit mip level.' },
  { name: 'tex2Dgrad', kind: 'function', category: 'unitycg', returnType: 'float4', parameters: [{ type: 'sampler2D', name: 'sampler' }, { type: 'float2', name: 'uv' }, { type: 'float2', name: 'ddx' }, { type: 'float2', name: 'ddy' }], documentation: 'Samples a 2D texture using explicit derivatives.' },
  { name: 'tex2Dbias', kind: 'function', category: 'unitycg', returnType: 'float4', parameters: [{ type: 'sampler2D', name: 'sampler' }, { type: 'float4', name: 'uv_bias' }], documentation: 'Samples a 2D texture with a mip bias.' },
  { name: 'texCUBE', kind: 'function', category: 'unitycg', returnType: 'float4', parameters: [{ type: 'samplerCUBE', name: 'sampler' }, { type: 'float3', name: 'dir' }], documentation: 'Samples a cube map using a direction vector.' },
  { name: 'texCUBElod', kind: 'function', category: 'unitycg', returnType: 'float4', parameters: [{ type: 'samplerCUBE', name: 'sampler' }, { type: 'float4', name: 'dir_lod' }], documentation: 'Samples a cube map with an explicit mip level.' },
  { name: 'UNITY_SAMPLE_TEX2D', kind: 'macro', category: 'unitycg', detail: 'UnityCG texture sampling macro', documentation: 'Samples a 2D texture using Unity’s legacy sampler abstraction.' },
  { name: 'UNITY_DECLARE_TEX2D', kind: 'macro', category: 'unitycg', detail: 'UnityCG texture declaration macro', documentation: 'Declares a 2D texture with paired sampler using Unity’s legacy abstraction.' },
  { name: 'UNITY_PASS_TEX2D', kind: 'macro', category: 'unitycg', detail: 'UnityCG texture forwarding macro', documentation: 'Forwards a Unity-declared 2D texture into another function.' },
  // === UnityCG built-in matrices and globals ===
  ...UNITY_BUILTIN_MACROS,
  ...UNITY_BUILTIN_GLOBALS,
  { name: 'POSITION', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'NORMAL', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'TANGENT', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'TEXCOORD0', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'TEXCOORD1', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'COLOR', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  {
    name: 'SV_POSITION',
    kind: 'semantic',
    category: 'semantic',
    detail: 'System position semantic',
    quickDocumentation: unityDocumentation(
      'Carries the system position between shader stages; Unity cross-compiles this semantic for supported graphics APIs.',
      'Unity shader semantics',
      'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-ShaderSemantics.html',
    ),
  },
  {
    name: 'SV_Target',
    kind: 'semantic',
    category: 'semantic',
    detail: 'Render-target output semantic',
    quickDocumentation: unityDocumentation(
      'Writes a fragment-shader output to a render target; an optional index selects the target.',
      'Unity shader semantics',
      'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-ShaderSemantics.html',
    ),
  },
  { name: 'SV_VertexID', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_InstanceID', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  // === ShaderLab syntax and semantic roles ===
  shaderLabKeyword('Shader', 'ShaderLab Shader block keyword', unityDocumentation(
    'Defines a Shader object and contains Properties, SubShaders, and optional fallback/editor declarations.',
    'Shader block reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-Shader.html',
  )),
  shaderLabKeyword('Properties', 'ShaderLab Properties block keyword', unityDocumentation(
    'Defines Material properties that Unity serializes with each Material asset.',
    'Properties block reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-Properties.html',
  )),
  shaderLabKeyword('SubShader', 'ShaderLab SubShader block keyword', unityDocumentation(
    'Defines one render-pipeline or hardware-compatible implementation of a Shader.',
    'SubShader block reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-SubShader.html',
  )),
  shaderLabKeyword('Pass', 'ShaderLab Pass block keyword', unityDocumentation(
    'Defines one rendering Pass and its render state and shader programs.',
    'Pass block reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-Pass.html',
  )),
  shaderLabKeyword('Name', 'ShaderLab Pass name declaration'),
  shaderLabKeyword(
    'UsePass',
    'ShaderLab pass reuse directive',
    unityDocumentation(
      'Inserts a named Pass from another Shader; the referenced Pass name is uppercase.',
      'UsePass directive reference',
      'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-UsePass.html',
    ),
  ),
  shaderLabKeyword('GrabPass', 'ShaderLab grab pass directive'),
  shaderLabKeyword('Fallback', 'ShaderLab fallback shader directive', unityDocumentation(
    'Selects another Shader when no SubShader in this Shader is supported.',
    'Fallback block reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-Fallback.html',
  )),
  shaderLabKeyword('CustomEditor', 'ShaderLab custom inspector directive'),
  shaderLabKeyword('Category', 'ShaderLab category block keyword'),
  shaderLabKeyword('HLSLPROGRAM', 'ShaderLab HLSL program marker', unityDocumentation(
    'Starts an HLSL program block compiled for the containing Pass.',
    'ShaderLab code blocks',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/shader-shaderlab-code-blocks.html',
  )),
  shaderLabKeyword('ENDHLSL', 'ShaderLab HLSL program marker'),
  shaderLabKeyword('CGPROGRAM', 'ShaderLab CG program marker'),
  shaderLabKeyword('ENDCG', 'ShaderLab CG program marker'),
  shaderLabKeyword('HLSLINCLUDE', 'ShaderLab HLSL include marker'),
  shaderLabKeyword('CGINCLUDE', 'ShaderLab CG include marker'),
  shaderLabRenderState(
    'Blend',
    true,
    unityDocumentation(
      'Configures how the GPU combines source and destination colors.',
      'Blend command reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-Blend.html',
    ),
  ),
  shaderLabRenderState(
    'Cull',
    true,
    unityDocumentation(
      'Selects front-face, back-face, or disabled polygon culling.',
      'Cull command reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-Cull.html',
    ),
  ),
  shaderLabRenderState(
    'ZWrite',
    true,
    unityDocumentation(
      'Enables or disables writing fragment depth to the depth buffer.',
      'ZWrite command reference',
    'https://docs.unity3d.com/2022.3/Documentation/Manual/SL-ZWrite.html',
    ),
  ),
  shaderLabRenderState('ZTest', true),
  shaderLabRenderState('Offset', true),
  shaderLabRenderState('ColorMask', true),
  shaderLabStateKeyword('Tags'),
  shaderLabStateKeyword('LOD'),
  shaderLabRenderState('Stencil'),
  shaderLabRenderState('BlendOp', true),
  shaderLabRenderState('Lighting', true),
  shaderLabRenderState('Material'),
  shaderLabRenderState('Fog', true),
  shaderLabRenderState('AlphaToMask', true),
  shaderLabRenderState('Conservative', true),
  ...shaderLabPropertyTypes(),
  shaderLabPropertyAttribute('Gamma', 'Marks a float or vector Property as an sRGB value.'),
  shaderLabPropertyAttribute('HDR', 'Marks a texture or color Property as high dynamic range.'),
  shaderLabPropertyAttribute('HideInInspector', 'Hides the Property in the Material Inspector.'),
  shaderLabPropertyAttribute('MainTexture', 'Selects the Material main texture Property.'),
  shaderLabPropertyAttribute('MainColor', 'Selects the Material main color Property.'),
  shaderLabPropertyAttribute('NoScaleOffset', 'Hides tiling and offset controls for a texture Property.'),
  shaderLabPropertyAttribute('Normal', 'Marks a texture Property as expecting a normal map.'),
  shaderLabPropertyAttribute('PerRendererData', 'Sources a texture Property from per-renderer data.'),
  // === ShaderLab state values (blend factors, blend ops, ztest, stencil ops) ===
  shaderLabStateValue('Off'),
  shaderLabStateValue('On'),
  shaderLabStateValue('Back'),
  shaderLabStateValue('Front'),
  shaderLabStateValue('Always'),
  shaderLabStateValue('LEqual'),
  shaderLabStateValue('Less'),
  shaderLabStateValue('Greater'),
  shaderLabStateValue('Equal'),
  shaderLabStateValue('Zero'),
  shaderLabStateValue('One'),
  shaderLabStateValue('SrcColor'),
  shaderLabStateValue('SrcAlpha'),
  shaderLabStateValue('DstColor'),
  shaderLabStateValue('DstAlpha'),
  shaderLabStateValue('OneMinusSrcColor'),
  shaderLabStateValue('OneMinusSrcAlpha'),
  shaderLabStateValue('OneMinusDstColor'),
  shaderLabStateValue('OneMinusDstAlpha'),
  shaderLabStateValue('Add'),
  shaderLabStateValue('Sub'),
  shaderLabStateValue('RevSub'),
  shaderLabStateValue('Min'),
  shaderLabStateValue('Max'),
  shaderLabStateValue('Never'),
  shaderLabStateValue('GEqual'),
  shaderLabStateValue('NotEqual'),
  shaderLabStateValue('Replace'),
  shaderLabStateValue('Keep'),
  shaderLabStateValue('Invert'),
  shaderLabStateValue('IncrSat'),
  shaderLabStateValue('DecrSat'),
  shaderLabStateValue('IncrWrap'),
  shaderLabStateValue('DecrWrap'),
  // === Additional shader semantics ===
  { name: 'TEXCOORD2', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'TEXCOORD3', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'TEXCOORD4', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'TEXCOORD5', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'TEXCOORD6', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'TEXCOORD7', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'COLOR0', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'COLOR1', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'COLOR2', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'COLOR3', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'SV_Depth', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_DepthGreaterEqual', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_DepthLessEqual', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_RenderTargetArrayIndex', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_ViewportArrayIndex', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_PrimitiveID', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_IsFrontFace', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_SampleIndex', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_GroupID', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_GroupThreadID', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_DispatchThreadID', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'SV_DomainLocation', kind: 'semantic', category: 'semantic', detail: 'System value semantic' },
  { name: 'BLENDINDICES', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'BLENDWEIGHT', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'PSIZE', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
  { name: 'VFACE', kind: 'semantic', category: 'semantic', detail: 'Shader semantic' },
] satisfies readonly BuiltinEntry[];

const EMPTY_ENTRIES: readonly BuiltinEntry[] = Object.freeze([]);
const ENTRIES_BY_NAME = new Map<string, readonly BuiltinEntry[]>();
const ENTRIES_BY_PARENT_TYPE = new Map<string, readonly BuiltinEntry[]>();

for (const entry of BUILTIN_ENTRIES) {
  ENTRIES_BY_NAME.set(entry.name, [
    ...(ENTRIES_BY_NAME.get(entry.name) ?? EMPTY_ENTRIES),
    entry,
  ]);
  if (entry.parentType) {
    ENTRIES_BY_PARENT_TYPE.set(entry.parentType, [
      ...(ENTRIES_BY_PARENT_TYPE.get(entry.parentType) ?? EMPTY_ENTRIES),
      entry,
    ]);
  }
}

function hasRole(entry: BuiltinEntry, role: BuiltinRole): boolean {
  return entry.roles?.includes(role) ?? false;
}

function uniqueEntriesByName(entries: readonly BuiltinEntry[]): readonly BuiltinEntry[] {
  const seenNames = new Set<string>();
  return entries.filter((entry) => {
    if (seenNames.has(entry.name)) return false;
    seenNames.add(entry.name);
    return true;
  });
}

const ENTRIES_BY_CONTEXT: Readonly<Record<BuiltinContext, readonly BuiltinEntry[]>> = {
  hlsl: uniqueEntriesByName(BUILTIN_ENTRIES.filter((entry) => (
    !entry.parentType
    && (
      entry.category === 'hlsl'
      || entry.category === 'unitycg'
      || entry.category === 'srp-core'
      || entry.category === 'urp'
      || entry.category === 'hdrp'
    )
  ))),
  semantic: uniqueEntriesByName(BUILTIN_ENTRIES.filter((entry) => entry.kind === 'semantic')),
  shaderLab: uniqueEntriesByName(BUILTIN_ENTRIES.filter((entry) => (
    entry.category === 'shaderlab' && !hasRole(entry, 'shaderLabStateValue')
  ))),
  shaderLabStateValue: uniqueEntriesByName(BUILTIN_ENTRIES.filter((entry) => (
    hasRole(entry, 'shaderLabStateValue')
  ))),
};

/** Exact-name lookup used by Hover and other name-oriented projections. */
export function findBuiltinEntries(name: string): readonly BuiltinEntry[] {
  return ENTRIES_BY_NAME.get(name) ?? EMPTY_ENTRIES;
}

/** Context projection used by Completion without reinterpreting category/kind. */
export function builtinEntriesForContext(
  context: BuiltinContext,
): readonly BuiltinEntry[] {
  return ENTRIES_BY_CONTEXT[context];
}

/** Receiver-owned projection used by member Completion without parsing types downstream. */
export function builtinMemberEntriesForReceiverType(
  receiverType: string,
  prefix = '',
): readonly BuiltinEntry[] {
  const receiver = receiverTypeFacts(receiverType);
  const canonicalType = receiver.canonicalType;
  const declaredMembers = (ENTRIES_BY_PARENT_TYPE.get(canonicalType) ?? EMPTY_ENTRIES)
    .filter((entry) => entry.name.startsWith(prefix));
  const typeShape = receiver.typeShape ?? findBuiltinEntries(canonicalType)
    .find((entry) => entry.kind === 'type')?.typeShape;
  if (typeShape?.kind === 'vector') {
    return [...declaredMembers, ...vectorSwizzleEntries(canonicalType, typeShape, prefix)];
  }
  if (typeShape?.kind === 'matrix') {
    return [...declaredMembers, ...matrixComponentEntries(canonicalType, typeShape, prefix)];
  }
  return declaredMembers;
}

/** Exact callable lookup used by Signature Help. */
export function findBuiltinFunctions(name: string): readonly BuiltinEntry[] {
  return findBuiltinEntries(name).filter((entry) => (
    entry.kind === 'function'
    && !entry.parentType
    && entry.parameters !== undefined
  ));
}

/** Exact receiver-owned callable lookup used by member Signature Help. */
export function findBuiltinMemberFunctions(
  receiverType: string,
  name: string,
): readonly BuiltinEntry[] {
  return builtinMemberEntriesForReceiverType(receiverType, name).filter((entry) => (
    entry.name === name
    && entry.kind === 'function'
    && entry.parameters !== undefined
  ));
}

/** Neutral lexical projection consumed by parsing-derived semantic coloring. */
export function builtinLexicalRole(
  name: string,
  context: BuiltinLexicalContext,
): BuiltinLexicalRole | undefined {
  for (const entry of findBuiltinEntries(name)) {
    if (entry.parentType) continue;
    switch (context) {
      case 'hlsl':
        if (entry.category === 'shaderlab') break;
        if (
          entry.kind === 'function'
          || entry.kind === 'keyword'
          || entry.kind === 'macro'
          || entry.kind === 'type'
          || entry.kind === 'variable'
        ) {
          return entry.kind;
        }
        if (entry.kind === 'semantic') return 'semantic';
        break;
      case 'shaderLab':
        if (
          hasRole(entry, 'shaderLabKeyword')
          || hasRole(entry, 'shaderLabRenderState')
        ) return 'keyword';
        break;
      case 'shaderLabProperty':
        if (hasRole(entry, 'shaderLabPropertyType')) return 'type';
        break;
    }
  }
  return undefined;
}

function canonicalReceiverType(receiverType: string): string {
  return receiverType.trim().replace(/\s*<.*>\s*$/, '');
}

function receiverTypeFacts(receiverType: string): {
  readonly canonicalType: string;
  readonly typeShape?: BuiltinTypeShape;
} {
  const trimmedType = receiverType.trim();
  const vector = /^vector(?:\s*<\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*([1-4]))?\s*>)?$/.exec(
    trimmedType,
  );
  if (vector) {
    return {
      canonicalType: 'vector',
      typeShape: {
        kind: 'vector',
        elementType: vector[1] ?? 'float',
        size: Number(vector[2] ?? 4) as 1 | 2 | 3 | 4,
      },
    };
  }

  const matrix = /^matrix(?:\s*<\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*([1-4])(?:\s*,\s*([1-4]))?)?\s*>)?$/.exec(
    trimmedType,
  );
  if (matrix) {
    return {
      canonicalType: 'matrix',
      typeShape: {
        kind: 'matrix',
        elementType: matrix[1] ?? 'float',
        rows: Number(matrix[2] ?? 4) as 1 | 2 | 3 | 4,
        columns: Number(matrix[3] ?? 4) as 1 | 2 | 3 | 4,
      },
    };
  }

  return { canonicalType: canonicalReceiverType(receiverType) };
}

function vectorSwizzleEntries(
  parentType: string,
  shape: Extract<BuiltinTypeShape, { readonly kind: 'vector' }>,
  prefix: string,
): BuiltinEntry[] {
  const alphabets = ['xyzw'.slice(0, shape.size), 'rgba'.slice(0, shape.size)];
  const entries: BuiltinEntry[] = [];
  for (const alphabet of alphabets) {
    if (prefix.length > 4 || [...prefix].some((character) => !alphabet.includes(character))) {
      continue;
    }
    for (let length = Math.max(1, prefix.length); length <= 4; length++) {
      appendSwizzles(entries, parentType, shape.elementType, alphabet, prefix, length);
    }
  }
  return entries;
}

function appendSwizzles(
  entries: BuiltinEntry[],
  parentType: string,
  elementType: string,
  alphabet: string,
  value: string,
  targetLength: number,
): void {
  if (value.length === targetLength) {
    entries.push({
      name: value,
      kind: 'structMember',
      category: 'hlsl',
      parentType,
      declaredType: targetLength === 1 ? elementType : `${elementType}${targetLength}`,
      detail: 'HLSL vector swizzle',
    });
    return;
  }
  for (const character of alphabet) {
    appendSwizzles(
      entries,
      parentType,
      elementType,
      alphabet,
      value + character,
      targetLength,
    );
  }
}

function matrixComponentEntries(
  parentType: string,
  shape: Extract<BuiltinTypeShape, { readonly kind: 'matrix' }>,
  prefix: string,
): BuiltinEntry[] {
  const entries: BuiltinEntry[] = [];
  for (let row = 0; row < shape.rows; row++) {
    for (let column = 0; column < shape.columns; column++) {
      for (const name of [`_m${row}${column}`, `_${row + 1}${column + 1}`]) {
        if (!name.startsWith(prefix)) continue;
        entries.push({
          name,
          kind: 'structMember',
          category: 'hlsl',
          parentType,
          declaredType: shape.elementType,
          detail: 'HLSL matrix component',
        });
      }
    }
  }
  return entries;
}

/** Parse one authoritative ShaderLab Property type term. */
export function asShaderLabPropertyType(name: string): ShaderLabPropertyType | null {
  return findBuiltinEntries(name).some((entry) => (
    hasRole(entry, 'shaderLabPropertyType')
  ))
    ? name as ShaderLabPropertyType
    : null;
}

/** Whether a ShaderLab command head admits the curated state-value context. */
export function isShaderLabStateValueContext(name: string): boolean {
  return findBuiltinEntries(name).some((entry) => (
    hasRole(entry, 'shaderLabStateValueContext')
  ));
}
