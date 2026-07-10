import * as nodePath from 'node:path';

type PathApi = Pick<typeof nodePath, 'isAbsolute' | 'relative' | 'resolve'>;

interface PathComparisonOptions {
  path?: PathApi;
  platform?: NodeJS.Platform;
}

export function normalizePathForComparison(
  absPath: string,
  options: Pick<PathComparisonOptions, 'platform'> = {},
): string {
  return (options.platform ?? process.platform) === 'win32'
    ? absPath.toLowerCase()
    : absPath;
}

export function containsPath(
  root: string,
  candidate: string,
  options: PathComparisonOptions = {},
): boolean {
  const pathApi = options.path ?? nodePath;
  const normalizedRoot = normalizePathForComparison(pathApi.resolve(root), options);
  const normalizedCandidate = normalizePathForComparison(pathApi.resolve(candidate), options);
  const rel = pathApi.relative(normalizedRoot, normalizedCandidate);

  return rel === ''
    || (!!rel && !isParentRelativePath(rel) && !pathApi.isAbsolute(rel));
}

function isParentRelativePath(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');
}
