import type { Connection } from 'vscode-languageserver/node';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@unity-shader-nav/shared';

type PartialSettings = Partial<Omit<ExtensionSettings, 'findReferences'>> & {
  findReferences?: Partial<ExtensionSettings['findReferences']>;
};

export async function loadSettings(connection: Connection): Promise<ExtensionSettings> {
  try {
    const got = await connection.workspace.getConfiguration({ section: 'unityShaderNav' });
    const raw = (got ?? {}) as PartialSettings;
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      findReferences: {
        ...DEFAULT_SETTINGS.findReferences,
        ...(raw.findReferences ?? {}),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function onSettingsChanged(
  connection: Connection,
  onChange: (settings: ExtensionSettings) => void | Promise<void>,
): void {
  connection.onDidChangeConfiguration(async () => {
    const settings = await loadSettings(connection);
    await onChange(settings);
  });
}
