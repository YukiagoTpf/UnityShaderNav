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

type Validator = (value: unknown, context: ValidationContext) => boolean;
type FieldValidators<T extends object> = {
  readonly [K in keyof T]-?: Validator;
};

const symbolKinds = new Set<SymbolKind>([
  'function',
  'variable',
  'parameter',
  'localVariable',
  'struct',
  'structMember',
  'macro',
  'cbuffer',
]);

const referenceContexts = new Set<ReferenceContext>([
  'call',
  'type',
  'member',
  'pragma',
  'identifier',
  'include',
]);

const shaderLabBlockKinds = new Set<BlockKind>([
  'HLSLPROGRAM',
  'CGPROGRAM',
  'HLSLINCLUDE',
  'CGINCLUDE',
]);

const shaderLabPropertyTypes = new Set<ShaderLabPropertyType>([
  '2D',
  '2DArray',
  '3D',
  'Cube',
  'CubeArray',
  'Color',
  'Vector',
  'Float',
  'Range',
  'Int',
  'Integer',
]);

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

const stringValue: Validator = (value) => typeof value === 'string';
const booleanValue: Validator = (value) => typeof value === 'boolean';
const finiteNumber: Validator = (value) => (
  typeof value === 'number' && Number.isFinite(value)
);

function optional(validator: Validator): Validator {
  return (value, context) => value === undefined || validator(value, context);
}

function arrayOf(validator: Validator): Validator {
  return (value, context) => (
    Array.isArray(value) && value.every((entry) => validator(entry, context))
  );
}

const positionFields = {
  line: finiteNumber,
  character: finiteNumber,
} satisfies FieldValidators<Position>;

const positionValue: Validator = (value, context) => (
  validateRecord(value, positionFields, context)
);

const rangeFields = {
  start: positionValue,
  end: positionValue,
} satisfies FieldValidators<Range>;

const rangeValue: Validator = (value, context) => (
  validateRecord(value, rangeFields, context)
);

type SymbolLocation = SymbolEntry['location'];

const symbolLocationFields = {
  uri: (value, context) => (
    typeof value === 'string' && value === context.expectedUri
  ),
  range: rangeValue,
} satisfies FieldValidators<SymbolLocation>;

const symbolLocationValue: Validator = (value, context) => (
  validateRecord(value, symbolLocationFields, context)
);

const functionParameterFields = {
  name: stringValue,
  type: stringValue,
  range: rangeValue,
} satisfies FieldValidators<FunctionParameter>;

const functionParameterValue: Validator = (value, context) => (
  validateRecord(value, functionParameterFields, context)
);

const symbolEntryFields = {
  name: stringValue,
  kind: (value) => (
    typeof value === 'string' && symbolKinds.has(value as SymbolKind)
  ),
  location: symbolLocationValue,
  scope: optional(stringValue),
  parentType: optional(stringValue),
  scopeRange: optional(rangeValue),
  declaredType: optional(stringValue),
} satisfies FieldValidators<SymbolEntry>;

const functionSymbolEntryFields = {
  ...symbolEntryFields,
  kind: (value) => value === 'function',
  returnType: stringValue,
  parameters: arrayOf(functionParameterValue),
} satisfies FieldValidators<FunctionSymbolEntry>;

const symbolEntryValue: Validator = (value, context) => {
  if (!isRecord(value)) return false;
  return value.kind === 'function'
    ? validateRecord(value, functionSymbolEntryFields, context)
    : validateRecord(value, symbolEntryFields, context);
};

const referenceEntryFields = {
  name: stringValue,
  location: symbolLocationValue,
  context: (value) => (
    typeof value === 'string' && referenceContexts.has(value as ReferenceContext)
  ),
  receiver: optional(stringValue),
} satisfies FieldValidators<ReferenceEntry>;

const referenceEntryValue: Validator = (value, context) => (
  validateRecord(value, referenceEntryFields, context)
);

const typeInferenceEntryFields = {
  receiver: stringValue,
  callName: stringValue,
  assignmentRange: rangeValue,
  scope: optional(stringValue),
  scopeRange: optional(rangeValue),
} satisfies FieldValidators<TypeInferenceEntry>;

const typeInferenceEntryValue: Validator = (value, context) => (
  validateRecord(value, typeInferenceEntryFields, context)
);

function shaderLabStructureNodeValue(
  value: unknown,
  context: ValidationContext,
): boolean {
  return validateRecord(value, shaderLabStructureNodeFields, context);
}

const shaderLabStructureNodeFields = {
  kind: (value) => value === 'shader' || value === 'subshader' || value === 'pass',
  name: optional(stringValue),
  headerLine: finiteNumber,
  closeLine: finiteNumber,
  children: arrayOf(shaderLabStructureNodeValue),
} satisfies FieldValidators<ShaderLabStructureNode>;

const structureResultFields = {
  shaders: arrayOf(shaderLabStructureNodeValue),
} satisfies FieldValidators<StructureResult>;

const structureResultValue: Validator = (value, context) => (
  validateRecord(value, structureResultFields, context)
);

const shaderLabPropertyEntryFields = {
  name: stringValue,
  nameRange: rangeValue,
  declarationRange: rangeValue,
  type: (value) => (
    value === null
    || (typeof value === 'string' && shaderLabPropertyTypes.has(value as ShaderLabPropertyType))
  ),
} satisfies FieldValidators<ShaderLabPropertyEntry>;

const shaderLabPropertyEntryValue: Validator = (value, context) => (
  validateRecord(value, shaderLabPropertyEntryFields, context)
);

const shaderLabShaderNameEntryFields = {
  name: stringValue,
  nameRange: rangeValue,
  declarationRange: rangeValue,
} satisfies FieldValidators<ShaderLabShaderNameEntry>;

const shaderLabShaderNameEntryValue: Validator = (value, context) => (
  validateRecord(value, shaderLabShaderNameEntryFields, context)
);

const shaderLabPassNameEntryFields = {
  shaderName: stringValue,
  name: stringValue,
  canonicalName: stringValue,
  nameRange: rangeValue,
  declarationRange: rangeValue,
} satisfies FieldValidators<ShaderLabPassNameEntry>;

const shaderLabPassNameEntryValue: Validator = (value, context) => (
  validateRecord(value, shaderLabPassNameEntryFields, context)
);

const shaderLabFallbackReferenceFields = {
  kind: (value) => value === 'fallback',
  shaderName: stringValue,
  shaderNameRange: rangeValue,
  directiveRange: rangeValue,
} satisfies FieldValidators<ShaderLabFallbackReference>;

const shaderLabUsePassReferenceFields = {
  kind: (value) => value === 'usePass',
  shaderName: stringValue,
  passName: stringValue,
  canonicalPassName: stringValue,
  shaderNameRange: rangeValue,
  passNameRange: rangeValue,
  directiveRange: rangeValue,
} satisfies FieldValidators<ShaderLabUsePassReference>;

const shaderLabNameReferenceValue: Validator = (value, context) => {
  if (!isRecord(value)) return false;
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

const shaderLabNameFactsValue: Validator = (value, context) => (
  validateRecord(value, shaderLabNameFactsFields, context)
);

const shaderLabMaterialFieldEntryFields = {
  name: stringValue,
  type: stringValue,
  packOffset: optional(stringValue),
  nameRange: rangeValue,
  declarationRange: rangeValue,
  conditional: booleanValue,
} satisfies FieldValidators<ShaderLabMaterialFieldEntry>;

const shaderLabMaterialFieldEntryValue: Validator = (value, context) => (
  validateRecord(value, shaderLabMaterialFieldEntryFields, context)
);

const blockKindValue: Validator = (value) => (
  typeof value === 'string' && shaderLabBlockKinds.has(value as BlockKind)
);

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

const shaderLabMaterialCbufferEntryValue: Validator = (value, context) => (
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

const shaderLabProgramBlockEntryValue: Validator = (value, context) => (
  validateRecord(value, shaderLabProgramBlockEntryFields, context)
);

const shaderLabMaterialFactsFields = {
  srpEvidence: booleanValue,
  subShaderCount: finiteNumber,
  hasIncludes: booleanValue,
  lineEnding: (value) => value === '\n' || value === '\r\n',
  cbuffers: arrayOf(shaderLabMaterialCbufferEntryValue),
  programBlocks: arrayOf(shaderLabProgramBlockEntryValue),
} satisfies FieldValidators<ShaderLabMaterialFacts>;

const shaderLabMaterialFactsValue: Validator = (value, context) => (
  validateRecord(value, shaderLabMaterialFactsFields, context)
);

// The mapped type is deliberate: adding a FileIndex field without defining its
// persisted validator makes the server build fail instead of silently widening the cache seam.
const fileIndexFields = {
  uri: (value, context) => (
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
  return validateRecord<FileIndex>(value, fileIndexFields, context) ? value : null;
}
