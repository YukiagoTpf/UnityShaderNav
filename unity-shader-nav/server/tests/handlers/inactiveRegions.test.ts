import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  DEFAULT_SETTINGS,
  INACTIVE_REGIONS_REQUEST,
  type ExtensionSettings,
  type InactiveRegionsParams,
  type InactiveRegionsResult,
} from '@unity-shader-nav/shared';
import { registerInactiveRegionsHandler } from '../../src/handlers/inactiveRegions';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';

type RequestHandler = (params: InactiveRegionsParams) => Promise<InactiveRegionsResult>;

/**
 * Minimal fake Connection that captures the single `onRequest(method, fn)` call
 * the handler under test makes. Asserts the method name and stashes the handler.
 */
function fakeConnection(): { connection: Connection; getHandler: () => RequestHandler } {
  let handler: RequestHandler | undefined;
  const connection = {
    onRequest(method: string, fn: RequestHandler) {
      expect(method).toBe(INACTIVE_REGIONS_REQUEST);
      handler = fn;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return {
    connection,
    getHandler: () => {
      if (!handler) throw new Error('handler was not registered');
      return handler;
    },
  };
}

function documentsWith(uri: string, languageId: string, version: number, text: string) {
  const doc = TextDocument.create(uri, languageId, version, text);
  return {
    get(requestedUri: string) {
      return requestedUri === uri ? doc : undefined;
    },
  } as never;
}

function settingsGetter(settings: ExtensionSettings): (uri: string) => Promise<ExtensionSettings> {
  return async () => settings;
}

const enabledSettings: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  dimInactiveBranches: { enabled: true, opacity: 0.55 },
};
const disabledSettings: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  dimInactiveBranches: { enabled: false, opacity: 0.55 },
};

const HLSL_TEXT = [
  '#pragma multi_compile _ FOO_ON',
  '#ifdef FOO_ON',
  'int x = 1;',
  '#endif',
].join('\n');

const HLSL_INACTIVE_TEXT = [
  '#define BAR_ON', // 0
  '#ifndef BAR_ON', // 1  BAR_ON definitely defined -> ifndef dims as inactive
  'int x = 1;',     // 2
  '#endif',         // 3
].join('\n');

const SHADER_TEXT = [
  'Shader "X" {',          // 0
  'HLSLINCLUDE',           // 1
  '#pragma multi_compile _ BAR_ON', // 2
  'ENDHLSL',               // 3
  'SubShader {',           // 4
  'Pass {',                // 5
  'HLSLPROGRAM',           // 6
  '#ifdef BAR_ON',         // 7
  'float y = 2;',          // 8
  '#endif',                // 9
  'ENDHLSL',               // 10
  '}',                     // 11
  '}',                     // 12
  '}',                     // 13
].join('\n');

describe('registerInactiveRegionsHandler', () => {
  it('returns variant regions for an enabled .hlsl document and echoes the version', async () => {
    const { connection, getHandler } = fakeConnection();
    const uri = 'file:///t/x.hlsl';
    const documents = documentsWith(uri, 'hlsl', 7, HLSL_TEXT);

    registerInactiveRegionsHandler(
      connection,
      documents,
      {} as never,
      settingsGetter(enabledSettings),
      new RequestSuspender({ timeoutMs: 1000 }),
    );

    const result = await getHandler()({ textDocument: { uri, version: 7 } });

    expect(result.version).toBe(7);
    expect(result.regions).toEqual([
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
        reason: 'variant',
      },
    ]);
  });

  it('returns an inactive region for a definitely-false branch and echoes the version', async () => {
    const { connection, getHandler } = fakeConnection();
    const uri = 'file:///t/inactive.hlsl';
    const documents = documentsWith(uri, 'hlsl', 11, HLSL_INACTIVE_TEXT);

    registerInactiveRegionsHandler(
      connection,
      documents,
      {} as never,
      settingsGetter(enabledSettings),
      new RequestSuspender({ timeoutMs: 1000 }),
    );

    const result = await getHandler()({ textDocument: { uri, version: 11 } });

    expect(result.version).toBe(11);
    expect(result.regions).toEqual([
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
        reason: 'inactive',
      },
    ]);
  });

  it('returns empty regions (still echoing version) when dimming is disabled', async () => {
    const { connection, getHandler } = fakeConnection();
    const uri = 'file:///t/x.hlsl';
    const documents = documentsWith(uri, 'hlsl', 3, HLSL_TEXT);

    registerInactiveRegionsHandler(
      connection,
      documents,
      {} as never,
      settingsGetter(disabledSettings),
      new RequestSuspender({ timeoutMs: 1000 }),
    );

    const result = await getHandler()({ textDocument: { uri, version: 3 } });

    expect(result).toEqual({ version: 3, regions: [] });
  });

  it('returns empty regions when the document text is unavailable', async () => {
    const { connection, getHandler } = fakeConnection();
    const uri = 'file:///t/missing.hlsl';
    const documents = documentsWith('file:///t/other.hlsl', 'hlsl', 1, HLSL_TEXT);

    registerInactiveRegionsHandler(
      connection,
      documents,
      {} as never,
      settingsGetter(enabledSettings),
      new RequestSuspender({ timeoutMs: 1000 }),
    );

    const result = await getHandler()({ textDocument: { uri, version: 42 } });

    expect(result).toEqual({ version: 42, regions: [] });
  });

  it('analyzes only inside HLSL/CG blocks for a .shader URI (HLSLINCLUDE feeds a later HLSLPROGRAM)', async () => {
    const { connection, getHandler } = fakeConnection();
    const uri = 'file:///t/test.shader';
    const documents = documentsWith(uri, 'shaderlab', 5, SHADER_TEXT);

    registerInactiveRegionsHandler(
      connection,
      documents,
      {} as never,
      settingsGetter(enabledSettings),
      new RequestSuspender({ timeoutMs: 1000 }),
    );

    const result = await getHandler()({ textDocument: { uri, version: 5 } });

    expect(result.version).toBe(5);
    // The HLSLINCLUDE pragma declares BAR_ON file-wide, so the later
    // HLSLPROGRAM `#ifdef BAR_ON` body (file line 8) dims as variant.
    expect(result.regions).toEqual([
      {
        range: { start: { line: 8, character: 0 }, end: { line: 8, character: 0 } },
        reason: 'variant',
      },
    ]);
  });
});
