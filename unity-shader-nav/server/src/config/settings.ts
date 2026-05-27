import type { Connection } from 'vscode-languageserver/node';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@unity-shader-nav/shared';

type PartialSettings = Partial<Omit<ExtensionSettings, 'findReferences' | 'debug' | 'dimInactiveBranches'>> & {
  findReferences?: Partial<ExtensionSettings['findReferences']>;
  debug?: Partial<ExtensionSettings['debug']>;
  dimInactiveBranches?: Partial<ExtensionSettings['dimInactiveBranches']>;
};

function mergeSettings(rawValue: unknown): ExtensionSettings {
  const raw = (rawValue ?? {}) as PartialSettings;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    findReferences: {
      ...DEFAULT_SETTINGS.findReferences,
      ...(raw.findReferences ?? {}),
    },
    debug: {
      ...DEFAULT_SETTINGS.debug,
      ...(raw.debug ?? {}),
    },
    dimInactiveBranches: {
      ...DEFAULT_SETTINGS.dimInactiveBranches,
      ...(raw.dimInactiveBranches ?? {}),
    },
  };
}

function settingsFromDidChange(params: unknown): ExtensionSettings | undefined {
  const settings = (params as { settings?: unknown } | undefined)?.settings;
  if (settings === undefined || settings === null) return undefined;

  const section = (settings as { unityShaderNav?: unknown }).unityShaderNav ?? settings;
  return mergeSettings(section);
}

export async function loadSettings(
  connection: Connection,
  scopeUri?: string,
): Promise<ExtensionSettings> {
  try {
    const got = await connection.workspace.getConfiguration({
      section: 'unityShaderNav',
      scopeUri,
    });
    return mergeSettings(got);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function onSettingsChanged(
  connection: Connection,
  onChange: (settings: ExtensionSettings) => void | Promise<void>,
): void {
  connection.onDidChangeConfiguration(async (params) => {
    const settings = settingsFromDidChange(params) ?? await loadSettings(connection);
    await onChange(settings);
  });
}
