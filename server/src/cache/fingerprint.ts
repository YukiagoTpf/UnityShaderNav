import { createHash } from 'node:crypto';
import type { CacheFingerprint, ExtensionSettings } from '@unity-shader-nav/shared';
import {
  BUILTIN_DECLARATION_MACROS,
  BUILTIN_REFERENCE_MACROS,
  BUILTIN_SENTINEL_MACROS,
} from '../macros/builtin';
import type { ParserRuntimeAssets } from '../parser/runtimeAssets';

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

export function grammarVersionHash(runtimeAssets: ParserRuntimeAssets): string {
  return runtimeAssets.hlslGrammar.contentHash;
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

export function buildFingerprint(
  settings: ExtensionSettings,
  runtimeAssets: ParserRuntimeAssets | undefined,
  indexImplementation: string | undefined,
): CacheFingerprint | undefined {
  if (
    !runtimeAssets
    || !indexImplementation
    || !/^[0-9a-f]{64}$/.test(indexImplementation)
  ) return undefined;
  return {
    indexImplementation,
    grammarVersion: grammarVersionHash(runtimeAssets),
    settingsHash: settingsHash(settings),
    macroTableHash: macroTableHash(settings.declarationMacros),
  };
}

export function fingerprintsEqual(a: CacheFingerprint, b: CacheFingerprint): boolean {
  return a.indexImplementation === b.indexImplementation
    && a.grammarVersion === b.grammarVersion
    && a.settingsHash === b.settingsHash
    && a.macroTableHash === b.macroTableHash;
}
