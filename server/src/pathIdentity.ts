import * as nodePath from 'node:path';
import {
  normalizeFileIdentity,
  type FileIdentityOptions,
} from './fileIdentity';

type PathApi = Pick<typeof nodePath, 'resolve'>;

export interface PathIdentityOptions extends FileIdentityOptions {
  path?: PathApi;
}

export function normalizePathForComparison(
  absPath: string,
  options: Pick<PathIdentityOptions, 'platform'> = {},
): string {
  return normalizeFileIdentity(absPath, options);
}

/** Canonical process-local identity for an absolute filesystem target. */
export function pathIdentity(
  path: string,
  options: PathIdentityOptions = {},
): string {
  const pathApi = options.path ?? nodePath;
  return normalizePathForComparison(pathApi.resolve(path), options);
}

export function samePath(
  left: string,
  right: string,
  options: PathIdentityOptions = {},
): boolean {
  return pathIdentity(left, options) === pathIdentity(right, options);
}
