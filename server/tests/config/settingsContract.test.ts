import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  normalizeSettingValue,
  normalizeSettings,
  SETTING_DEFINITIONS,
  SETTING_PATHS,
  SETTING_SECTIONS,
  settingDocumentationType,
  settingsRequireReindex,
  type SettingSchema,
} from '@unity-shader-nav/shared';

const repositoryRoot = resolve(__dirname, '../../..');
const TRACE_SETTING = 'unityShaderNav.trace.server';
const PUBLIC_SETTING_SECTIONS = [...SETTING_SECTIONS, TRACE_SETTING];

describe('public settings contract', () => {
  it('matches every manifest key, default, schema, and scope', () => {
    const clientPackage = readJson(resolve(repositoryRoot, 'client/package.json'));
    const properties = nestedRecord(
      clientPackage,
      ['contributes', 'configuration', 'properties'],
      'client/package.json configuration properties',
    );

    expect(Object.keys(properties)).toEqual(PUBLIC_SETTING_SECTIONS);
    for (const path of SETTING_PATHS) {
      const section = `unityShaderNav.${path}`;
      const manifestSetting = recordValue(properties[section], section);
      const definition = SETTING_DEFINITIONS[path];

      expect(manifestSetting.scope, `${section} scope`).toBe('resource');
      expect(manifestSetting.default, `${section} default`).toEqual(definition.default);
      expect(manifestSchema(manifestSetting), `${section} schema`).toEqual(definition.schema);
    }
  });

  it('declares the standard client-only language-server trace contract', () => {
    const clientPackage = readJson(resolve(repositoryRoot, 'client/package.json'));
    const properties = nestedRecord(
      clientPackage,
      ['contributes', 'configuration', 'properties'],
      'client/package.json configuration properties',
    );
    const trace = recordValue(properties[TRACE_SETTING], TRACE_SETTING);

    expect(trace).toMatchObject({
      type: 'string',
      scope: 'window',
      enum: ['off', 'messages', 'verbose'],
      default: 'off',
    });
  });

  it('matches the complete canonical configuration document', () => {
    const document = readFileSync(resolve(repositoryRoot, 'docs/configuration.md'), 'utf8');
    const headings = Array.from(document.matchAll(/^## `([^`]+)`$/gm));

    expect(headings.map((heading) => heading[1])).toEqual(PUBLIC_SETTING_SECTIONS);
    for (const path of SETTING_PATHS) {
      const headingIndex = headings.findIndex((heading) => heading[1] === `unityShaderNav.${path}`);
      const heading = headings[headingIndex];
      const definition = SETTING_DEFINITIONS[path];
      const start = (heading.index ?? 0) + heading[0].length;
      const end = headings[headingIndex + 1]?.index ?? document.length;
      const section = document.slice(start, end);

      expect(section).toContain(`Type: \`${settingDocumentationType(definition.schema)}\``);
      expect(section).toContain(`Default: \`${JSON.stringify(definition.default)}\``);
      if (definition.schema.type === 'number'
          && definition.schema.minimum !== undefined
          && definition.schema.maximum !== undefined) {
        expect(section).toContain(
          `Range: \`${definition.schema.minimum}\`–\`${definition.schema.maximum}\``,
        );
      }
      for (const enumValue of enumValues(definition.schema)) {
        expect(section).toContain(`- \`${enumValue}\``);
      }
    }
    const traceHeadingIndex = headings.findIndex((heading) => heading[1] === TRACE_SETTING);
    const traceHeading = headings[traceHeadingIndex];
    const traceSection = document.slice(
      (traceHeading.index ?? 0) + traceHeading[0].length,
      headings[traceHeadingIndex + 1]?.index ?? document.length,
    );
    expect(traceSection).toContain('Type: `string`');
    expect(traceSection).toContain('Default: `"off"`');
    expect(traceSection).toContain('Values: `"off"`, `"messages"`, `"verbose"`');
  });

  it('derives isolated defaults and deep-merges valid nested leaves', () => {
    const settings = normalizeSettings({
      debug: { definitionTrace: true },
      dimInactiveBranches: { enabled: false },
    });

    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      debug: { definitionTrace: true },
      dimInactiveBranches: {
        enabled: false,
        opacity: DEFAULT_SETTINGS.dimInactiveBranches.opacity,
      },
    });
    expect(settings.includeDirectories).not.toBe(DEFAULT_SETTINGS.includeDirectories);
    expect(settings.debug).not.toBe(DEFAULT_SETTINGS.debug);
  });

  it('falls back leaf by leaf for invalid values without dropping valid siblings', () => {
    const settings = normalizeSettings({
      projectRoot: 42,
      includeDirectories: ['valid', 7],
      declarationMacros: [{ pattern: 'MY_MACRO($name)', kind: 'unknown' }],
      findReferences: { includePackages: 'yes' },
      dimInactiveBranches: { enabled: false, opacity: 2 },
    });

    expect(settings.projectRoot).toBe(DEFAULT_SETTINGS.projectRoot);
    expect(settings.includeDirectories).toEqual(DEFAULT_SETTINGS.includeDirectories);
    expect(settings.declarationMacros).toEqual(DEFAULT_SETTINGS.declarationMacros);
    expect(settings.findReferences).toEqual(DEFAULT_SETTINGS.findReferences);
    expect(settings.dimInactiveBranches).toEqual({ enabled: false, opacity: 0.55 });
  });

  it('projects valid object values onto the canonical schema', () => {
    const settings = normalizeSettings({
      declarationMacros: [{
        kind: 'variable',
        ignored: 'not part of the public contract',
        pattern: 'MY_MACRO($name)',
      }],
    });

    expect(settings.declarationMacros).toEqual([
      { pattern: 'MY_MACRO($name)', kind: 'variable' },
    ]);
  });

  it('normalizes invalid client-consumed leaves through the same contract', () => {
    expect(normalizeSettingValue('dimInactiveBranches.enabled', 'yes')).toBe(true);
    expect(normalizeSettingValue('dimInactiveBranches.opacity', 2)).toBe(0.55);
    expect(normalizeSettingValue('dimInactiveBranches.opacity', 0.4)).toBe(0.4);
  });

  it('derives reindex behavior for every setting leaf', () => {
    for (const path of SETTING_PATHS) {
      const changed = withChangedSetting(DEFAULT_SETTINGS, path);
      expect(settingsRequireReindex(DEFAULT_SETTINGS, changed), path).toBe(
        SETTING_DEFINITIONS[path].requiresReindex,
      );
    }
  });
});

function withChangedSetting(
  settings: typeof DEFAULT_SETTINGS,
  path: (typeof SETTING_PATHS)[number],
): typeof DEFAULT_SETTINGS {
  const changed = normalizeSettings(settings);
  switch (path) {
    case 'projectRoot':
      changed.projectRoot = '/different';
      break;
    case 'includeDirectories':
      changed.includeDirectories = ['/different'];
      break;
    case 'excludePatterns':
      changed.excludePatterns = ['different'];
      break;
    case 'declarationMacros':
      changed.declarationMacros = [{ pattern: 'DIFFERENT($name)', kind: 'variable' }];
      break;
    case 'findReferences.includePackages':
      changed.findReferences.includePackages = true;
      break;
    case 'debug.definitionTrace':
      changed.debug.definitionTrace = true;
      break;
    case 'dimInactiveBranches.enabled':
      changed.dimInactiveBranches.enabled = false;
      break;
    case 'dimInactiveBranches.opacity':
      changed.dimInactiveBranches.opacity = 0.75;
      break;
    default:
      return assertNever(path);
  }
  return changed;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled setting path ${String(value)}`);
}

function manifestSchema(setting: Record<string, unknown>): unknown {
  const schema = { ...setting };
  delete schema.scope;
  delete schema.default;
  delete schema.description;
  return withoutDescriptions(schema);
}

function enumValues(schema: SettingSchema): string[] {
  if (schema.type === 'string') return schema.enum ? [...schema.enum] : [];
  if (schema.type === 'array') return enumValues(schema.items);
  if (schema.type === 'object') {
    return Object.values(schema.properties).flatMap(enumValues);
  }
  return [];
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, nested]) => [key, withoutDescriptions(nested)]),
  );
}

function readJson(file: string): Record<string, unknown> {
  return recordValue(JSON.parse(readFileSync(file, 'utf8')), file);
}

function nestedRecord(
  root: Record<string, unknown>,
  path: string[],
  description: string,
): Record<string, unknown> {
  let current: unknown = root;
  for (const segment of path) current = recordValue(current, description)[segment];
  return recordValue(current, description);
}

function recordValue(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${description} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
