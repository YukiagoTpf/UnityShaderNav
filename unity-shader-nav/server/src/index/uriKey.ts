export function uriKey(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return uri;

    const drive = parsed.pathname.match(/^\/([a-z])(?::|%3A)(\/.*)?$/i);
    if (drive) {
      return `file:///${drive[1].toLowerCase()}:${drive[2] ?? ''}`;
    }
  } catch {
    // Fall through to the original string for non-URL keys.
  }

  return uri;
}
