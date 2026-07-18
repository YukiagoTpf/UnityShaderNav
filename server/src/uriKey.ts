import {
  normalizeFileIdentity,
  type FileIdentityOptions,
} from './fileIdentity';

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

/** Canonical identity for file URIs used across registries and indexes. */
export function uriKey(uri: string, options: FileIdentityOptions = {}): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return uri;
    const decodedSegments = decodePathSegments(parsed.pathname);
    const decodedPath = decodedSegments.join('/');
    const platform = isWindowsFilePath(decodedPath, parsed.hostname)
      ? 'win32'
      : options.platform;
    parsed.pathname = encodePathSegments(decodedSegments.map((segment) => (
      normalizeFileIdentity(segment, { platform })
    )));
    return parsed.href;
  } catch {
    // Fall through to the original string for non-URL keys.
  }

  return uri;
}
