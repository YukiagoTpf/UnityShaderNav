import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  moduleBelongsToRuntime,
  type ParserRuntimeAssets,
} from '../parser/runtimeAssets';

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Resolve the persisted-cache release identity for an explicitly supported runtime. */
export function releaseVersionForModule(
  moduleFile: string,
  runtimeAssets: ParserRuntimeAssets,
): string | undefined {
  if (
    runtimeAssets.layout !== 'bundled-server'
    || !moduleBelongsToRuntime(moduleFile, runtimeAssets)
  ) return undefined;

  try {
    const packageJson = JSON.parse(readFileSync(
      resolve(runtimeAssets.runtimeRoot, '..', '..', 'package.json'),
      'utf8',
    )) as { version?: unknown };
    return typeof packageJson.version === 'string'
      && RELEASE_VERSION.test(packageJson.version)
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}

export function runningReleaseVersion(
  runtimeAssets: ParserRuntimeAssets,
): string | undefined {
  return releaseVersionForModule(__filename, runtimeAssets);
}
