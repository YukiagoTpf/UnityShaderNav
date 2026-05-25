import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { CacheFingerprint, ExtensionSettings } from '@unity-shader-nav/shared';
import {
  BUILTIN_DECLARATION_MACROS,
  BUILTIN_REFERENCE_MACROS,
  BUILTIN_SENTINEL_MACROS,
} from '../macros/builtin';

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

export async function grammarVersionHash(wasmPath: string): Promise<string> {
  try {
    const bytes = await fs.readFile(wasmPath);
    return createHash('sha1').update(bytes).digest('hex');
  } catch {
    return 'no-wasm';
  }
}

export function settingsHash(settings: ExtensionSettings): string {
  const subset = {
    declarationMacros: [...settings.declarationMacros]
      .map((macro) => ({ pattern: macro.pattern, kind: macro.kind }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern) || a.kind.localeCompare(b.kind)),
    includeDirectories: [...settings.includeDirectories].sort(),
    excludePatterns: [...settings.excludePatterns].sort(),
  };

  return sha1(JSON.stringify(subset));
}

export function macroTableHash(userMacros: ExtensionSettings['declarationMacros']): string {
  const all = [
    ...BUILTIN_DECLARATION_MACROS.map((macro) => ({
      pattern: macro.pattern,
      kind: macro.kind,
      source: 'builtin-declaration',
    })),
    ...BUILTIN_REFERENCE_MACROS.map((macro) => ({
      pattern: macro.pattern,
      kind: macro.kind,
      source: 'builtin-reference',
    })),
    ...BUILTIN_SENTINEL_MACROS.map((macro) => ({
      pattern: macro,
      kind: 'sentinel',
      source: 'builtin-sentinel',
    })),
    ...userMacros.map((macro) => ({
      pattern: macro.pattern,
      kind: macro.kind,
      source: 'user',
    })),
  ].sort((a, b) => (
    a.pattern.localeCompare(b.pattern)
    || String(a.kind).localeCompare(String(b.kind))
    || a.source.localeCompare(b.source)
  ));

  return sha1(JSON.stringify(all));
}

export async function buildFingerprint(
  settings: ExtensionSettings,
  wasmPath: string,
): Promise<CacheFingerprint> {
  return {
    grammarVersion: await grammarVersionHash(wasmPath),
    settingsHash: settingsHash(settings),
    macroTableHash: macroTableHash(settings.declarationMacros),
  };
}

export function fingerprintsEqual(a: CacheFingerprint, b: CacheFingerprint): boolean {
  return a.grammarVersion === b.grammarVersion
    && a.settingsHash === b.settingsHash
    && a.macroTableHash === b.macroTableHash;
}
