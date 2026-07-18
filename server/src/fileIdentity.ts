export interface FileIdentityOptions {
  platform?: NodeJS.Platform;
}

/**
 * Normalize a filesystem spelling according to the host's default identity
 * semantics. This intentionally does not resolve paths or change separators;
 * URI and filesystem callers layer those concerns around this shared rule.
 */
export function normalizeFileIdentity(
  value: string,
  options: FileIdentityOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return value.normalize('NFC').toLowerCase().normalize('NFC');
  if (platform === 'win32') return value.toLowerCase();
  return value;
}
