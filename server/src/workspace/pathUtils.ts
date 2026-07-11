import * as nodePath from 'node:path';
import {
  pathIdentity,
  type PathIdentityOptions,
} from '../pathIdentity';

export { normalizePathForComparison } from '../pathIdentity';

type PathApi = Pick<typeof nodePath, 'isAbsolute' | 'relative' | 'resolve'>;

interface PathComparisonOptions extends PathIdentityOptions {
  path?: PathApi;
}

export function containsPath(
  root: string,
  candidate: string,
  options: PathComparisonOptions = {},
): boolean {
  const pathApi = options.path ?? nodePath;
  const normalizedRoot = pathIdentity(root, { ...options, path: pathApi });
  const normalizedCandidate = pathIdentity(candidate, { ...options, path: pathApi });
  const rel = pathApi.relative(normalizedRoot, normalizedCandidate);

  return rel === ''
    || (!!rel && !isParentRelativePath(rel) && !pathApi.isAbsolute(rel));
}

function isParentRelativePath(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');
}
