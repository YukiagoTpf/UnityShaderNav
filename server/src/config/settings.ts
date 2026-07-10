import type { Connection } from 'vscode-languageserver/node';
import {
  normalizeSettings,
  SETTINGS_SECTION,
  type ExtensionSettings,
} from '@unity-shader-nav/shared';

function settingsFromDidChange(params: unknown): ExtensionSettings | undefined {
  const settings = (params as { settings?: unknown } | undefined)?.settings;
  if (settings === undefined || settings === null) return undefined;

  const section = (settings as { unityShaderNav?: unknown }).unityShaderNav ?? settings;
  return normalizeSettings(section);
}

export async function loadSettings(
  connection: Connection,
  scopeUri?: string,
): Promise<ExtensionSettings> {
  try {
    const got = await connection.workspace.getConfiguration({
      section: SETTINGS_SECTION,
      scopeUri,
    });
    return normalizeSettings(got);
  } catch {
    return normalizeSettings(undefined);
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
