export type DeclarationMacroKind = 'variable' | 'cbuffer';

export interface UserDeclarationMacro {
  /** Pattern source, e.g. "MY_TEX2D($name)" or "MY_CBUFFER($name)". */
  pattern: string;
  /** Symbol kind to register the captured $name as. */
  kind: DeclarationMacroKind;
}

export interface ExtensionSettings {
  projectRoot: string;
  includeDirectories: string[];
  excludePatterns: string[];
  declarationMacros: UserDeclarationMacro[];
  findReferences: { includePackages: boolean };
  debug: { definitionTrace: boolean };
  dimInactiveBranches: { enabled: boolean; opacity: number };
}

export type SettingSchema =
  | { type: 'string'; enum?: readonly string[] }
  | { type: 'boolean' }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'array'; items: SettingSchema }
  | {
    type: 'object';
    properties: Readonly<Record<string, SettingSchema>>;
    required: readonly string[];
  };

type LeafPaths<T> = {
  [K in keyof T & string]: T[K] extends readonly unknown[]
    ? K
    : T[K] extends object
      ? `${K}.${LeafPaths<T[K]>}`
      : K;
}[keyof T & string];

type ValueAtPath<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? ValueAtPath<T[K], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

export type SettingPath = LeafPaths<ExtensionSettings>;
export type SettingValueAtPath<P extends SettingPath> = ValueAtPath<ExtensionSettings, P>;
export const SETTINGS_SECTION = 'unityShaderNav' as const;
export type SettingSection = `${typeof SETTINGS_SECTION}.${SettingPath}`;

export interface SettingDefinition<Value = unknown> {
  default: Value;
  schema: SettingSchema;
  requiresReindex: boolean;
}

export const SETTING_DEFINITIONS = deepFreeze({
  projectRoot: {
    default: '',
    schema: { type: 'string' },
    requiresReindex: true,
  },
  includeDirectories: {
    default: [],
    schema: { type: 'array', items: { type: 'string' } },
    requiresReindex: true,
  },
  excludePatterns: {
    default: ['**/Library/**', '**/Temp/**', '**/Logs/**'],
    schema: { type: 'array', items: { type: 'string' } },
    requiresReindex: true,
  },
  declarationMacros: {
    default: [],
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          kind: { type: 'string', enum: ['variable', 'cbuffer'] },
        },
        required: ['pattern', 'kind'],
      },
    },
    requiresReindex: true,
  },
  'findReferences.includePackages': {
    default: false,
    schema: { type: 'boolean' },
    requiresReindex: false,
  },
  'debug.definitionTrace': {
    default: false,
    schema: { type: 'boolean' },
    requiresReindex: false,
  },
  'dimInactiveBranches.enabled': {
    default: true,
    schema: { type: 'boolean' },
    requiresReindex: false,
  },
  'dimInactiveBranches.opacity': {
    default: 0.55,
    schema: { type: 'number', minimum: 0.1, maximum: 1 },
    requiresReindex: false,
  },
} satisfies {
  [P in SettingPath]: SettingDefinition<ValueAtPath<ExtensionSettings, P>>;
});

export const SETTING_PATHS: readonly SettingPath[] = Object.freeze(
  Object.keys(SETTING_DEFINITIONS) as SettingPath[],
);
export const SETTING_SECTIONS: readonly SettingSection[] = Object.freeze(
  SETTING_PATHS.map((path): SettingSection => `${SETTINGS_SECTION}.${path}`),
);

export function normalizeSettings(rawValue: unknown): ExtensionSettings {
  const result: Record<string, unknown> = {};
  for (const path of SETTING_PATHS) {
    const candidate = valueAtPath(rawValue, path);
    setValueAtPath(result, path, normalizeSettingValue(path, candidate));
  }
  return result as unknown as ExtensionSettings;
}

export function normalizeSettingValue<P extends SettingPath>(
  path: P,
  rawValue: unknown,
): SettingValueAtPath<P> {
  const definition = definitionFor(path);
  if (!isSettingValue(definition.default, definition.schema)) {
    throw new Error(`Invalid default in settings contract for ${path}`);
  }
  const value = isSettingValue(rawValue, definition.schema) ? rawValue : definition.default;
  return projectSettingValue(value, definition.schema) as SettingValueAtPath<P>;
}

export function settingsRequireReindex(
  previous: ExtensionSettings,
  next: ExtensionSettings,
): boolean {
  return SETTING_PATHS.some((path) => {
    const definition = definitionFor(path);
    return definition.requiresReindex
      && JSON.stringify(valueAtPath(previous, path)) !== JSON.stringify(valueAtPath(next, path));
  });
}

export function settingDocumentationType(schema: SettingSchema): string {
  switch (schema.type) {
    case 'string':
    case 'boolean':
    case 'number':
    case 'object':
      return schema.type;
    case 'array':
      return `${settingDocumentationType(schema.items)}[]`;
  }
}

export const DEFAULT_SETTINGS: ExtensionSettings = deepFreeze(
  normalizeSettings(undefined),
) as ExtensionSettings;

function definitionFor(path: SettingPath): SettingDefinition {
  return SETTING_DEFINITIONS[path] as SettingDefinition;
}

function isSettingValue(value: unknown, schema: SettingSchema): boolean {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' && (!schema.enum || schema.enum.includes(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number'
        && Number.isFinite(value)
        && (schema.minimum === undefined || value >= schema.minimum)
        && (schema.maximum === undefined || value <= schema.maximum);
    case 'array':
      return Array.isArray(value) && value.every((item) => isSettingValue(item, schema.items));
    case 'object':
      if (!isRecord(value)) return false;
      if (schema.required.some((key) => !(key in value))) return false;
      return Object.entries(schema.properties).every(([key, propertySchema]) => (
        !(key in value) || isSettingValue(value[key], propertySchema)
      ));
  }
}

function valueAtPath(value: unknown, path: SettingPath): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setValueAtPath(target: Record<string, unknown>, path: SettingPath, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (isRecord(existing)) {
      current = existing;
    } else {
      const nested: Record<string, unknown> = {};
      current[segment] = nested;
      current = nested;
    }
  }
  current[segments[segments.length - 1]] = value;
}

function projectSettingValue(value: unknown, schema: SettingSchema): unknown {
  switch (schema.type) {
    case 'string':
    case 'boolean':
    case 'number':
      return value;
    case 'array':
      return (value as unknown[]).map((item) => projectSettingValue(item, schema.items));
    case 'object': {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(schema.properties)
          .filter(([key]) => key in record)
          .map(([key, propertySchema]) => [
            key,
            projectSettingValue(record[key], propertySchema),
          ]),
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type DeepReadonly<Value> = Value extends readonly unknown[]
  ? { readonly [K in keyof Value]: DeepReadonly<Value[K]> }
  : Value extends object
    ? { readonly [K in keyof Value]: DeepReadonly<Value[K]> }
    : Value;

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}
