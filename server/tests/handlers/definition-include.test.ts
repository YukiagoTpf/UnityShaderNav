import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection, DefinitionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { registerDefinitionHandler } from '../../src/handlers/definition';
import {
  createDocumentRegistry,
  createIndexedWorkspaceFixture,
} from '../helpers/indexedWorkspaceFixture';

const root = resolve(__dirname, '../include/fixtures/projectA');
const caseSensitivityRoot = resolve(__dirname, '../include/fixtures/caseSensitivity');

describe('registerDefinitionHandler: include definitions', () => {
  it('returns a location link for the include path under the cursor', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const warnings: string[] = [];
    const connection = {
      console: {
        warn(message: string) {
          warnings.push(message);
        },
      },
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const filePath = join(root, 'Assets/Shaders/Main.shader');
    const uri = pathToFileURL(filePath).href;
    const text = [
      'Shader "T/Inc" {',
      '  HLSLPROGRAM',
      '  #include <Common.hlsl>',
      '  #include_with_pragmas "Common.hlsl"',
      '  ENDHLSL',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'shaderlab', 1, text);
    const documents = createDocumentRegistry(doc);
    const workspace = createIndexedWorkspaceFixture([], {
      includeCtx: { unityProjectRoot: root, includeDirectories: [] },
    });
    const manager = {
      servingWorkspaceFor(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    };

    registerDefinitionHandler(
      connection,
      documents,
      manager,
    );

    const expectedUri = pathToFileURL(join(root, 'Assets/Shaders/Common.hlsl')).href;
    for (const line of [2, 3]) {
      const character = text.split('\n')[line].indexOf('Common.hlsl') + 1;
      const result = await handler?.({
        textDocument: { uri },
        position: { line, character },
      }) as Array<{ targetUri: string }> | null | undefined;

      expect(result).toHaveLength(1);
      expect(result?.[0].targetUri).toBe(expectedUri);
    }
    expect(warnings).toEqual([]);
  });

  it('does not resolve include paths inside multi-line block comments', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const connection = {
      console: {
        warn() {},
      },
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const filePath = join(root, 'Assets/Shaders/Main.shader');
    const uri = pathToFileURL(filePath).href;
    const text = [
      'Shader "T/Inc" {',
      '  HLSLPROGRAM',
      '  /*',
      '  #include "Common.hlsl"',
      '  */',
      '  ENDHLSL',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'shaderlab', 1, text);
    const documents = createDocumentRegistry(doc);
    const workspace = createIndexedWorkspaceFixture([], {
      includeCtx: { unityProjectRoot: root, includeDirectories: [] },
    });
    const manager = {
      servingWorkspaceFor(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    };

    registerDefinitionHandler(connection, documents, manager);

    const result = await handler?.({
      textDocument: { uri },
      position: { line: 3, character: 14 },
    });

    expect(result).toBeNull();
  });

  it('warns when include resolution falls back to a case-insensitive match', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const warnings: string[] = [];
    const connection = {
      console: {
        log() {},
        warn(message: string) {
          warnings.push(message);
        },
      },
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const filePath = join(caseSensitivityRoot, 'Assets/Shaders/Main.hlsl');
    const uri = pathToFileURL(filePath).href;
    const text = '#include "Helper.hlsl"';
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const documents = createDocumentRegistry(doc);
    const workspace = createIndexedWorkspaceFixture([], {
      includeCtx: { unityProjectRoot: caseSensitivityRoot, includeDirectories: [] },
    });
    const manager = {
      servingWorkspaceFor(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    };

    registerDefinitionHandler(connection, documents, manager);

    const result = await handler?.({
      textDocument: { uri },
      position: { line: 0, character: 12 },
    }) as Array<{ targetUri: string }> | null | undefined;
    const targetPath = join(caseSensitivityRoot, 'Assets/Shaders/helper.hlsl');

    expect(result).toHaveLength(1);
    expect(result?.[0].targetUri).toBe(pathToFileURL(targetPath).href);
    expect(warnings).toEqual([
      `[UnityShaderNav] case-insensitive include match: "Helper.hlsl" -> ${targetPath}`,
    ]);
  });
});
