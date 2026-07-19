import { describe, expect, it } from 'vitest';
import type {
  Connection,
  Location,
  ReferenceParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  ADAPTER_INTERFACE_VERSION,
  MATERIAL_USAGES_ADAPTER_FEATURE,
  type AdapterHandshake,
  type MaterialReferenceLocation,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type { MaterialSource } from '../../src/adapter/materialSource';
import { registerReferencesHandler } from '../../src/handlers/references';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';
import {
  createDocumentRegistry,
  createIndexedWorkspaceFixture,
} from '../helpers/indexedWorkspaceFixture';

const now = 1_000_000;
const shaderUri = 'file:///project/Assets/Shaders/Lit.shader';
const materialUri = 'file:///project/Assets/Materials/Ship.mat';
const shaderText = [
  'Shader "Tests/Lit" {',
  '  Properties {',
  '    _Tint ("Tint", Color) = (1,1,1,1)',
  '  }',
  '  SubShader {}',
  '}',
].join('\n');

function handshake(instanceId = 'editor-1'): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: now,
    instanceId,
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      adapterVersion: '0.2.0',
      supportedFeatures: [MATERIAL_USAGES_ADAPTER_FEATURE],
    },
  };
}

function captureReferencesHandler(): {
  connection: Connection;
  handler(): (params: ReferenceParams) => Promise<Location[] | null>;
} {
  let registered: ((params: ReferenceParams) => Promise<Location[] | null>) | undefined;
  const connection = {
    onReferences(handler: (params: ReferenceParams) => Promise<Location[] | null>) {
      registered = handler;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return {
    connection,
    handler() {
      if (!registered) throw new Error('references handler was not registered');
      return registered;
    },
  };
}

async function handlerWithRegistry(
  registry: AdapterRegistry,
  text = shaderText,
) {
  const document = TextDocument.create(shaderUri, 'shaderlab', 1, text);
  const documents = createDocumentRegistry(document);
  const workspace = createIndexedWorkspaceFixture(
    [await indexFile(shaderUri, text)],
    { materialUsages: registry },
  );
  const { connection, handler } = captureReferencesHandler();
  registerReferencesHandler(connection, documents, {
    servingWorkspaceFor: (uri) => documents.snapshot(uri) ? workspace : undefined,
  });
  return handler();
}

async function registeredHandler(source: MaterialSource) {
  const registry = new AdapterRegistry({ now: () => now });
  registry.registerHandshake('project-a', handshake(), source);
  return handlerWithRegistry(registry);
}

function materialLocations(
  locations: Location[] | null,
): MaterialReferenceLocation[] {
  return (locations ?? []).filter(
    (location): location is MaterialReferenceLocation => (
      'data' in location
      && location.data?.kind === 'material-property'
    ),
  );
}

describe('ShaderLab Property Material References overlay', () => {
  it('includes a matching Material with stable asset identity and provenance', async () => {
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: 'materials-1',
          collectedAt: now,
          materials: [{
            guid: '11111111111111111111111111111111',
            path: 'Assets/Materials/Ship.mat',
            properties: [{
              name: '_Tint',
              type: 'vector',
              serializedValue: [1, 0.5, 0.25, 1],
            }],
          }],
        };
      },
    };
    const handler = await registeredHandler(source);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });
    const material = result?.find(
      (location): location is MaterialReferenceLocation => location.uri === materialUri,
    );

    expect(material).toEqual({
      uri: materialUri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      data: {
        kind: 'material-property',
        asset: {
          guid: '11111111111111111111111111111111',
          path: 'Assets/Materials/Ship.mat',
        },
        property: {
          name: '_Tint',
          type: 'vector',
          serializedValue: [1, 0.5, 0.25, 1],
        },
        shaderPropertyType: 'Color',
        compatibility: 'compatible',
        completeness: {
          assetScope: 'complete',
          runtimeMaterials: 'unknown',
        },
        provenance: {
          capability: MATERIAL_USAGES_ADAPTER_FEATURE,
          projectId: 'project-a',
          instanceId: 'editor-1',
          adapterVersion: '0.2.0',
          unityVersion: '2022.3.62f1',
          collectedAt: now,
          sourceRevision: 'materials-1',
        },
      },
    });
  });

  it('annotates serialized value type drift against the ShaderLab contract', async () => {
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: 'materials-drifted',
          collectedAt: now,
          materials: [{
            guid: '11111111111111111111111111111111',
            path: 'Assets/Materials/Ship.mat',
            properties: [{
              name: '_Tint',
              type: 'float',
              serializedValue: 0.75,
            }],
          }],
        };
      },
    };
    const handler = await registeredHandler(source);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });
    const material = result?.find(
      (location): location is MaterialReferenceLocation => location.uri === materialUri,
    );

    expect(material?.data).toMatchObject({
      shaderPropertyType: 'Color',
      property: { name: '_Tint', type: 'float', serializedValue: 0.75 },
      compatibility: 'type-mismatch',
    });
  });

  it('includes Materials from the matching same-file HLSL declaration', async () => {
    const text = [
      'Shader "Tests/Lit" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    float4 _Tint;',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: 'materials-1',
          collectedAt: now,
          materials: [{
            guid: '11111111111111111111111111111111',
            path: 'Assets/Materials/Ship.mat',
            properties: [],
          }],
        };
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), source);
    const handler = await handlerWithRegistry(registry, text);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 6, character: 12 },
      context: { includeDeclaration: true },
    });

    expect(materialLocations(result)).toHaveLength(1);
    expect(materialLocations(result)[0].data).toMatchObject({
      property: null,
      shaderPropertyType: 'Color',
      compatibility: 'not-serialized',
    });
  });

  it('refreshes a serialized Property rename without hiding the Material usage', async () => {
    let propertyName = '_Tint';
    let revision = 1;
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: `materials-${revision}`,
          collectedAt: now,
          materials: [{
            guid: '11111111111111111111111111111111',
            path: 'Assets/Materials/Ship.mat',
            properties: [{
              name: propertyName,
              type: 'vector',
              serializedValue: [1, 1, 1, 1],
            }],
          }],
        };
      },
    };
    const handler = await registeredHandler(source);
    const params: ReferenceParams = {
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    };

    expect(materialLocations(await handler(params))).toHaveLength(1);

    propertyName = '_RenamedTint';
    revision++;

    const renamed = materialLocations(await handler(params));
    expect(renamed).toHaveLength(1);
    expect(renamed[0].data).toMatchObject({
      asset: { guid: '11111111111111111111111111111111' },
      property: null,
      compatibility: 'not-serialized',
      provenance: { sourceRevision: 'materials-2' },
    });
  });

  it('refreshes Material deletion without publishing a fake Shader symbol', async () => {
    let deleted = false;
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: deleted ? 'materials-2' : 'materials-1',
          collectedAt: now,
          materials: deleted ? [] : [{
            guid: '11111111111111111111111111111111',
            path: 'Assets/Materials/Ship.mat',
            properties: [{
              name: '_Tint',
              type: 'vector',
              serializedValue: [1, 1, 1, 1],
            }],
          }],
        };
      },
    };
    const handler = await registeredHandler(source);
    const params: ReferenceParams = {
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    };

    const before = await handler(params);
    deleted = true;
    const after = await handler(params);

    expect(materialLocations(before)).toHaveLength(1);
    expect(materialLocations(after)).toEqual([]);
    expect(after).toEqual(before?.filter((location) => location.uri !== materialUri));
  });

  it('keeps static Property References available when the Adapter is unavailable', async () => {
    const registry = new AdapterRegistry({ now: () => now });
    const handler = await handlerWithRegistry(registry);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(result).not.toBeNull();
    expect(materialLocations(result)).toEqual([]);
  });
});
