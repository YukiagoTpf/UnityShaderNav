import type {
  BlockKind,
  FileIndex,
  FunctionParameter,
  FunctionSymbolEntry,
  Position,
  Range,
  ReferenceContext,
  ReferenceEntry,
  ShaderLabFallbackReference,
  ShaderLabMaterialCbufferEntry,
  ShaderLabMaterialFacts,
  ShaderLabMaterialFieldEntry,
  ShaderLabNameFacts,
  ShaderLabNodeKind,
  ShaderLabPassNameEntry,
  ShaderLabProgramBlockEntry,
  ShaderLabPropertyEntry,
  ShaderLabPropertyType,
  ShaderLabShaderNameEntry,
  ShaderLabStructureNode,
  ShaderLabUsePassReference,
  StructureResult,
  SymbolEntry,
  SymbolKind,
  TypeInferenceEntry,
} from '@unity-shader-nav/shared';

interface ValidationContext {
  readonly expectedUri: string;
}

type Validator<T> = (
  value: unknown,
  context: ValidationContext,
) => value is T;

type FieldValidators<T extends object> = {
  readonly [K in keyof T]-?: Validator<T[K]>;
};

const SYMBOL_KINDS = {
  function: true,
  variable: true,
  parameter: true,
  localVariable: true,
  struct: true,
  structMember: true,
  macro: true,
  cbuffer: true,
} satisfies Record<SymbolKind, true>;

const REFERENCE_CONTEXTS = {
  call: true,
  type: true,
  member: true,
  pragma: true,
  identifier: true,
  include: true,
} satisfies Record<ReferenceContext, true>;

const SHADERLAB_BLOCK_KINDS = {
  HLSLPROGRAM: true,
  CGPROGRAM: true,
  HLSLINCLUDE: true,
  CGINCLUDE: true,
} satisfies Record<BlockKind, true>;

const SHADERLAB_NODE_KINDS = {
  shader: true,
  properties: true,
  subshader: true,
  pass: true,
} satisfies Record<ShaderLabNodeKind, true>;

const SHADERLAB_PROPERTY_TYPES = {
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

const SHADERLAB_LINE_ENDINGS = {
  '\n': true,
  '\r\n': true,
} satisfies Record<ShaderLabMaterialFacts['lineEnding'], true>;

type ShaderLabNameReference = ShaderLabNameFacts['references'][number];

const SHADERLAB_NAME_REFERENCE_KINDS = {
  fallback: true,
  usePass: true,
} satisfies Record<ShaderLabNameReference['kind'], true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRecord<T extends object>(
  value: unknown,
  validators: FieldValidators<T>,
  context: ValidationContext,
): value is T {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !Object.hasOwn(validators, key))) return false;
  return (Object.keys(validators) as Array<keyof T & string>).every(
    (key) => validators[key](value[key], context),
  );
}

const stringValue: Validator<string> = (value): value is string => (
  typeof value === 'string'
);

const booleanValue: Validator<boolean> = (value): value is boolean => (
  typeof value === 'boolean'
);

const finiteNumber: Validator<number> = (value): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

function enumValue<T extends string>(values: Record<T, true>): Validator<T> {
  return (value): value is T => (
    typeof value === 'string' && Object.hasOwn(values, value)
  );
}

function optional<T>(validator: Validator<T>): Validator<T | undefined> {
  return (value, context): value is T | undefined => (
    value === undefined || validator(value, context)
  );
}

function arrayOf<T>(validator: Validator<T>): Validator<T[]> {
  return (value, context): value is T[] => (
    Array.isArray(value) && value.every((entry) => validator(entry, context))
  );
}

const positionFields = {
  line: finiteNumber,
  character: finiteNumber,
} satisfies FieldValidators<Position>;

const positionValue: Validator<Position> = (value, context): value is Position => (
  validateRecord(value, positionFields, context)
);

const rangeFields = {
  start: positionValue,
  end: positionValue,
} satisfies FieldValidators<Range>;

const rangeValue: Validator<Range> = (value, context): value is Range => (
  validateRecord(value, rangeFields, context)
);

type SymbolLocation = SymbolEntry['location'];

const symbolLocationFields = {
  uri: (value, context): value is string => (
    typeof value === 'string' && value === context.expectedUri
  ),
  range: rangeValue,
} satisfies FieldValidators<SymbolLocation>;

const symbolLocationValue: Validator<SymbolLocation> = (
  value,
  context,
): value is SymbolLocation => validateRecord(value, symbolLocationFields, context);

const functionParameterFields = {
  name: stringValue,
  type: stringValue,
  range: rangeValue,
} satisfies FieldValidators<FunctionParameter>;

const functionParameterValue: Validator<FunctionParameter> = (
  value,
  context,
): value is FunctionParameter => validateRecord(value, functionParameterFields, context);

const symbolEntryFields = {
  name: stringValue,
  kind: enumValue(SYMBOL_KINDS),
  location: symbolLocationValue,
  scope: optional(stringValue),
  parentType: optional(stringValue),
  scopeRange: optional(rangeValue),
  declaredType: optional(stringValue),
} satisfies FieldValidators<SymbolEntry>;

const functionSymbolEntryFields = {
  ...symbolEntryFields,
  kind: (value): value is 'function' => value === 'function',
  returnType: stringValue,
  parameters: arrayOf(functionParameterValue),
} satisfies FieldValidators<FunctionSymbolEntry>;

const symbolEntryValue: Validator<SymbolEntry> = (
  value,
  context,
): value is SymbolEntry => {
  if (!isRecord(value)) return false;
  return value.kind === 'function'
    ? validateRecord(value, functionSymbolEntryFields, context)
    : validateRecord(value, symbolEntryFields, context);
};

const referenceEntryFields = {
  name: stringValue,
  location: symbolLocationValue,
  context: enumValue(REFERENCE_CONTEXTS),
  receiver: optional(stringValue),
} satisfies FieldValidators<ReferenceEntry>;

const referenceEntryValue: Validator<ReferenceEntry> = (
  value,
  context,
): value is ReferenceEntry => validateRecord(value, referenceEntryFields, context);

const typeInferenceEntryFields = {
  receiver: stringValue,
  callName: stringValue,
  assignmentRange: rangeValue,
  scope: optional(stringValue),
  scopeRange: optional(rangeValue),
} satisfies FieldValidators<TypeInferenceEntry>;

const typeInferenceEntryValue: Validator<TypeInferenceEntry> = (
  value,
  context,
): value is TypeInferenceEntry => validateRecord(value, typeInferenceEntryFields, context);

function shaderLabStructureNodeValue(
  value: unknown,
  context: ValidationContext,
): value is ShaderLabStructureNode {
  return validateRecord(value, shaderLabStructureNodeFields, context);
}

const shaderLabStructureNodeFields = {
  kind: enumValue(SHADERLAB_NODE_KINDS),
  name: optional(stringValue),
  headerLine: finiteNumber,
  closeLine: finiteNumber,
  children: arrayOf(shaderLabStructureNodeValue),
} satisfies FieldValidators<ShaderLabStructureNode>;

const structureResultFields = {
  shaders: arrayOf(shaderLabStructureNodeValue),
} satisfies FieldValidators<StructureResult>;

const structureResultValue: Validator<StructureResult> = (
  value,
  context,
): value is StructureResult => validateRecord(value, structureResultFields, context);

const shaderLabPropertyEntryFields = {
  name: stringValue,
  nameRange: rangeValue,
  declarationRange: rangeValue,
  type: (value): value is ShaderLabPropertyType | null => (
    value === null
    || (typeof value === 'string' && Object.hasOwn(SHADERLAB_PROPERTY_TYPES, value))
  ),
} satisfies FieldValidators<ShaderLabPropertyEntry>;

const shaderLabPropertyEntryValue: Validator<ShaderLabPropertyEntry> = (
  value,
  context,
): value is ShaderLabPropertyEntry => (
  validateRecord(value, shaderLabPropertyEntryFields, context)
);

const shaderLabShaderNameEntryFields = {
  name: stringValue,
  nameRange: rangeValue,
  declarationRange: rangeValue,
} satisfies FieldValidators<ShaderLabShaderNameEntry>;

const shaderLabShaderNameEntryValue: Validator<ShaderLabShaderNameEntry> = (
  value,
  context,
): value is ShaderLabShaderNameEntry => (
  validateRecord(value, shaderLabShaderNameEntryFields, context)
);

const shaderLabPassNameEntryFields = {
  shaderName: stringValue,
  name: stringValue,
  canonicalName: stringValue,
  nameRange: rangeValue,
  declarationRange: rangeValue,
} satisfies FieldValidators<ShaderLabPassNameEntry>;

const shaderLabPassNameEntryValue: Validator<ShaderLabPassNameEntry> = (
  value,
  context,
): value is ShaderLabPassNameEntry => (
  validateRecord(value, shaderLabPassNameEntryFields, context)
);

const shaderLabFallbackReferenceFields = {
  kind: (value): value is 'fallback' => value === 'fallback',
  shaderName: stringValue,
  shaderNameRange: rangeValue,
  directiveRange: rangeValue,
} satisfies FieldValidators<ShaderLabFallbackReference>;

const shaderLabUsePassReferenceFields = {
  kind: (value): value is 'usePass' => value === 'usePass',
  shaderName: stringValue,
  passName: stringValue,
  canonicalPassName: stringValue,
  shaderNameRange: rangeValue,
  passNameRange: rangeValue,
  directiveRange: rangeValue,
} satisfies FieldValidators<ShaderLabUsePassReference>;

const shaderLabNameReferenceValue: Validator<ShaderLabNameReference> = (
  value,
  context,
): value is ShaderLabNameReference => {
  if (!isRecord(value)) return false;
  if (
    typeof value.kind !== 'string'
    || !Object.hasOwn(SHADERLAB_NAME_REFERENCE_KINDS, value.kind)
  ) return false;
  if (value.kind === 'fallback') {
    return validateRecord(value, shaderLabFallbackReferenceFields, context);
  }
  if (value.kind === 'usePass') {
    return validateRecord(value, shaderLabUsePassReferenceFields, context);
  }
  return false;
};

const shaderLabNameFactsFields = {
  shaders: arrayOf(shaderLabShaderNameEntryValue),
  passes: arrayOf(shaderLabPassNameEntryValue),
  references: arrayOf(shaderLabNameReferenceValue),
} satisfies FieldValidators<ShaderLabNameFacts>;

const shaderLabNameFactsValue: Validator<ShaderLabNameFacts> = (
  value,
  context,
): value is ShaderLabNameFacts => validateRecord(value, shaderLabNameFactsFields, context);

const shaderLabMaterialFieldEntryFields = {
  name: stringValue,
  type: stringValue,
  packOffset: optional(stringValue),
  nameRange: rangeValue,
  declarationRange: rangeValue,
  conditional: booleanValue,
} satisfies FieldValidators<ShaderLabMaterialFieldEntry>;

const shaderLabMaterialFieldEntryValue: Validator<ShaderLabMaterialFieldEntry> = (
  value,
  context,
): value is ShaderLabMaterialFieldEntry => (
  validateRecord(value, shaderLabMaterialFieldEntryFields, context)
);

const blockKindValue = enumValue(SHADERLAB_BLOCK_KINDS);

const shaderLabMaterialCbufferEntryFields = {
  name: stringValue,
  nameRange: rangeValue,
  declarationRange: rangeValue,
  fields: arrayOf(shaderLabMaterialFieldEntryValue),
  blockIndex: finiteNumber,
  blockKind: blockKindValue,
  insertionPosition: positionValue,
  fieldIndent: stringValue,
  conditional: booleanValue,
  opaque: booleanValue,
  complete: booleanValue,
} satisfies FieldValidators<ShaderLabMaterialCbufferEntry>;

const shaderLabMaterialCbufferEntryValue: Validator<ShaderLabMaterialCbufferEntry> = (
  value,
  context,
): value is ShaderLabMaterialCbufferEntry => (
  validateRecord(value, shaderLabMaterialCbufferEntryFields, context)
);

const shaderLabProgramBlockEntryFields = {
  blockIndex: finiteNumber,
  kind: blockKindValue,
  startLine: finiteNumber,
  endLine: finiteNumber,
  insertionPosition: positionValue,
  indent: stringValue,
  unterminated: booleanValue,
} satisfies FieldValidators<ShaderLabProgramBlockEntry>;

const shaderLabProgramBlockEntryValue: Validator<ShaderLabProgramBlockEntry> = (
  value,
  context,
): value is ShaderLabProgramBlockEntry => (
  validateRecord(value, shaderLabProgramBlockEntryFields, context)
);

const shaderLabMaterialFactsFields = {
  srpEvidence: booleanValue,
  subShaderCount: finiteNumber,
  hasIncludes: booleanValue,
  lineEnding: enumValue(SHADERLAB_LINE_ENDINGS),
  cbuffers: arrayOf(shaderLabMaterialCbufferEntryValue),
  programBlocks: arrayOf(shaderLabProgramBlockEntryValue),
} satisfies FieldValidators<ShaderLabMaterialFacts>;

const shaderLabMaterialFactsValue: Validator<ShaderLabMaterialFacts> = (
  value,
  context,
): value is ShaderLabMaterialFacts => (
  validateRecord(value, shaderLabMaterialFactsFields, context)
);

// This mapped type is the schema-drift gate: adding any required or optional
// FileIndex fact without its persisted decoder fails the server build.
const fileIndexFields = {
  uri: (value, context): value is string => (
    typeof value === 'string' && value === context.expectedUri
  ),
  symbols: arrayOf(symbolEntryValue),
  references: arrayOf(referenceEntryValue),
  typeInferences: optional(arrayOf(typeInferenceEntryValue)),
  structure: optional(structureResultValue),
  properties: optional(arrayOf(shaderLabPropertyEntryValue)),
  shaderLabNames: optional(shaderLabNameFactsValue),
  shaderLabMaterial: optional(shaderLabMaterialFactsValue),
} satisfies FieldValidators<FileIndex>;

/** Decode one untrusted persisted FileIndex for the owning CachedFile URI. */
export function decodePersistedFileIndex(
  value: unknown,
  expectedUri: string,
): FileIndex | null {
  const context = { expectedUri };
  return validateRecord(value, fileIndexFields, context) ? value : null;
}
