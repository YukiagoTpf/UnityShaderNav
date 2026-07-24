export interface UriIdentityOptions {
  readonly platform?: NodeJS.Platform;
}

function normalizeFileIdentity(
  value: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'darwin') {
    return value.normalize('NFC').toLowerCase().normalize('NFC');
  }
  if (platform === 'win32') return value.toLowerCase();
  return value;
}

function decodePathSegments(pathname: string): string[] {
  return pathname.split('/').map((segment) => decodeURIComponent(segment));
}

function encodePathSegments(segments: readonly string[]): string {
  return segments.map((segment) => (
    encodeURIComponent(segment).replace(/%3A/gi, ':')
  )).join('/');
}

function isWindowsFilePath(pathname: string, hostname: string): boolean {
  return /^\/[A-Za-z]:(?:\/|$)/.test(pathname)
    || (hostname !== '' && hostname !== 'localhost');
}

function identityPlatform(
  pathname: string,
  hostname: string,
  options: UriIdentityOptions,
): NodeJS.Platform {
  return isWindowsFilePath(pathname, hostname)
    ? 'win32'
    : options.platform ?? process.platform;
}

/** Canonical process-local identity for a file URI. Non-file URIs are opaque. */
export function uriIdentityKey(
  uri: string,
  options: UriIdentityOptions = {},
): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return uri;
    const decodedSegments = decodePathSegments(parsed.pathname);
    const decodedPath = decodedSegments.join('/');
    const platform = identityPlatform(
      decodedPath,
      parsed.hostname,
      options,
    );
    parsed.pathname = encodePathSegments(decodedSegments.map((segment) => (
      normalizeFileIdentity(segment, platform)
    )));
    return parsed.href;
  } catch {
    return uri;
  }
}

function sourceNameSegments(
  sourceName: string,
  platform: NodeJS.Platform,
): readonly string[] | undefined {
  let path = sourceName.replace(/\\/g, '/');
  try {
    const parsed = new URL(sourceName);
    if (parsed.protocol === 'file:') path = parsed.pathname;
  } catch {
    // Compiler source names are commonly project-relative paths, not URIs.
  }
  const result: string[] = [];
  for (const encoded of path.split('/')) {
    if (encoded === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
    if (segment === '.' || segment === '..') return undefined;
    result.push(normalizeFileIdentity(segment, platform));
  }
  return result.length > 0 ? result : undefined;
}

/**
 * A compiler-reported source alias must identify a path suffix of the mapped
 * file URI. This accepts the basename, project-relative path, or absolute path
 * spellings emitted by compilers while rejecting an unrelated audit label.
 */
export function sourceNameMatchesUri(
  uri: string,
  sourceName: string,
  options: UriIdentityOptions = {},
): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return false;
    const decoded = decodePathSegments(parsed.pathname);
    const platform = identityPlatform(
      decoded.join('/'),
      parsed.hostname,
      options,
    );
    const uriSegments = decoded
      .filter((segment) => segment !== '')
      .map((segment) => normalizeFileIdentity(segment, platform));
    const aliasSegments = sourceNameSegments(sourceName, platform);
    if (!aliasSegments || aliasSegments.length > uriSegments.length) {
      return false;
    }
    const offset = uriSegments.length - aliasSegments.length;
    return aliasSegments.every(
      (segment, index) => segment === uriSegments[offset + index],
    );
  } catch {
    return false;
  }
}
