import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { loadSettings, onSettingsChanged } from '../../src/config/settings';

function connectionWithConfiguration(value: unknown): Connection {
  return {
    workspace: {
      getConfiguration: async () => value,
    },
  } as unknown as Connection;
}

describe('loadSettings', () => {
  it('falls back to defaults when configuration loading fails', async () => {
    const connection = {
      workspace: {
        getConfiguration: async () => {
          throw new Error('not ready');
        },
      },
    } as unknown as Connection;

    await expect(loadSettings(connection)).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('merges user declaration macros with default settings', async () => {
    const settings = await loadSettings(connectionWithConfiguration({
      declarationMacros: [{ pattern: 'MY_TEX2D($name)', kind: 'variable' }],
      findReferences: {},
    }));

    expect(settings.declarationMacros).toEqual([
      { pattern: 'MY_TEX2D($name)', kind: 'variable' },
    ]);
    expect(settings.excludePatterns).toEqual(DEFAULT_SETTINGS.excludePatterns);
    expect(settings.findReferences.includePackages).toBe(false);
    expect(settings.debug.definitionTrace).toBe(false);
  });

  it('merges debug settings with defaults', async () => {
    const settings = await loadSettings(connectionWithConfiguration({
      debug: { definitionTrace: true },
    }));

    expect(settings.debug.definitionTrace).toBe(true);
  });
});

describe('onSettingsChanged', () => {
  it('uses the pushed unityShaderNav settings section from didChangeConfiguration', async () => {
    let handler: ((params: unknown) => Promise<void>) | undefined;
    const connection = {
      onDidChangeConfiguration: (registered: (params: unknown) => Promise<void>) => {
        handler = registered;
      },
      workspace: {
        getConfiguration: async () => DEFAULT_SETTINGS,
      },
    } as unknown as Connection;

    let got = DEFAULT_SETTINGS;
    onSettingsChanged(connection, (settings) => {
      got = settings;
    });

    await handler!({
      settings: {
        unityShaderNav: {
          declarationMacros: [{ pattern: 'MY_TEX2D($name)', kind: 'variable' }],
          findReferences: {},
        },
      },
    });

    expect(got.declarationMacros).toEqual([
      { pattern: 'MY_TEX2D($name)', kind: 'variable' },
    ]);
  });
});
