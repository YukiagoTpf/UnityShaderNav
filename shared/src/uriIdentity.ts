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

/**
 * Bounded memo for `uriIdentityKey`. Every registry, index and cross-file
 * navigation join re-derives the identity of the same handful of URIs, so on a
 * production-scale project a single Find References resolves the same few
 * hundred URIs a million times over. The derivation is pure — URL parse, then
 * per-segment decode, Unicode fold and re-encode — but not cheap, so it is
 * cached rather than repeated.
 *
 * Keyed by the requested platform as well as the URI: the same URI folds
 * differently per platform, and callers pass an explicit platform in tests and
 * when interpreting evidence recorded elsewhere.
 */
const IDENTITY_CACHE_LIMIT = 8_192;
const identityCache = new Map<string, string>();
let derivationCount = 0;

/**
 * How many times an identity has actually been derived in this process.
 *
 * Exposed so a test can assert that repeats are served from the memo. Counting
 * derivations is deterministic, where timing the calls would really be
 * measuring how loaded the machine is — a wall-clock bound written against this
 * memo failed on a shared CI runner while the memo was working correctly.
 */
export function uriIdentityDerivationCount(): number {
  return derivationCount;
}

/** Canonical process-local identity for a file URI. Non-file URIs are opaque. */
export function uriIdentityKey(
  uri: string,
  options: UriIdentityOptions = {},
): string {
  // `identityPlatform` may still override this with win32 for an intrinsically
  // Windows URI; that is a pure function of the URI, so it does not affect the
  // key's soundness.
  const requestedPlatform = options.platform ?? process.platform;
  const cacheKey = `${requestedPlatform}\0${uri}`;
  const cached = identityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  derivationCount++;
  const identity = deriveUriIdentityKey(uri, options);
  // A plain insertion cap rather than an LRU: entries are per-URI and the
  // working set of a session is bounded by the indexed project, so the cap only
  // exists to keep a pathological URI stream from growing without limit.
  if (identityCache.size >= IDENTITY_CACHE_LIMIT) identityCache.clear();
  identityCache.set(cacheKey, identity);
  return identity;
}

function deriveUriIdentityKey(
  uri: string,
  options: UriIdentityOptions,
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
  // Compiler source names are commonly project-relative paths, not URIs, so a
  // literal '%' in a filename is data rather than an escape. Only the file: URL
  // spelling carries percent-encoded segments; decoding a plain path would
  // throw URIError on `50%Blend.hlsl` and silently rewrite `A%20B.hlsl`.
  let percentEncoded = false;
  try {
    const parsed = new URL(sourceName);
    if (parsed.protocol === 'file:') {
      path = parsed.pathname;
      percentEncoded = true;
    }
  } catch {
    // Not a URI spelling.
  }
  const result: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    let segment = raw;
    if (percentEncoded) {
      try {
        segment = decodeURIComponent(raw);
      } catch {
        return undefined;
      }
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
