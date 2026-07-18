import { createHash } from 'node:crypto';
import type { CacheFingerprint, ExtensionSettings } from '@unity-shader-nav/shared';
import { macroPatternIdentity } from '../macros';
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
  return macroPatternIdentity(userMacros);
}

export function buildFingerprint(
  settings: ExtensionSettings,
  runtimeAssets: ParserRuntimeAssets | undefined,
  releaseVersion: string | undefined,
): CacheFingerprint | undefined {
  if (
    !runtimeAssets
    || !releaseVersion
    || releaseVersion !== releaseVersion.trim()
  ) return undefined;
  return {
    releaseVersion,
    grammarVersion: grammarVersionHash(runtimeAssets),
    settingsHash: settingsHash(settings),
    macroTableHash: macroTableHash(settings.declarationMacros),
  };
}

export function fingerprintsEqual(a: CacheFingerprint, b: CacheFingerprint): boolean {
  return a.releaseVersion === b.releaseVersion
    && a.grammarVersion === b.grammarVersion
    && a.settingsHash === b.settingsHash
    && a.macroTableHash === b.macroTableHash;
}
