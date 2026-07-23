import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  Connection,
  Location,
  ReferenceParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  ADAPTER_INTERFACE_VERSION,
  CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
  type AdapterHandshake,
  type CSharpPropertyReferenceLocation,
  type CSharpPropertyUncertainLocation,
  type ShaderLabPropertyType,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type {
  AdapterCSharpPropertyUsage,
  CSharpCurrentSourceProvider,
  CSharpPropertySource,
  CSharpPropertyTarget,
} from '../../src/adapter/csharpPropertySource';
import { registerReferencesHandler } from '../../src/handlers/references';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';
import {
  createDocumentRegistry,
  createIndexedWorkspaceFixture,
} from '../helpers/indexedWorkspaceFixture';

const now = 1_000_000;
const shaderUri = 'file:///project/Assets/Shaders/Lit.shader';
const csUri = 'file:///project/Assets/Scripts/ShaderController.cs';
const shaderPath = 'Assets/Shaders/Lit.shader';
const shaderName = 'Tests/Lit';
const propertyName = '_Tint';

const shaderText = [
  'Shader "Tests/Lit" {',
  '  Properties {',
  '    _Tint ("Tint", Color) = (1,1,1,1)',
  '  }',
  '  SubShader {',
  '    Pass {',
  '      HLSLPROGRAM',
  '      float4 _Tint;',
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
].join('\n');

const csText = [
  'using UnityEngine;',
  '',
  'public class ShaderController : MonoBehaviour {',
  '    private static readonly int TintID = Shader.PropertyToID("_Tint");',
  '    public void SetTint(Material material, Color c) {',
  '        material.SetColor("_Tint", c);',
  '    }',
  '}',
].join('\n');

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function handshake(instanceId = 'editor-1'): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: now,
    instanceId,
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      adapterVersion: '0.2.0',
      supportedFeatures: [CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE],
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

/**
 * Build a PropertyToID usage (line 3: Shader.PropertyToID("_Tint")).
 * The name token "_Tint" sits at line 3, characters 57–62.
 */
function propertyToIdUsage(
  contentHash: string,
  overrides: Partial<AdapterCSharpPropertyUsage> = {},
): AdapterCSharpPropertyUsage {
  return {
    uri: csUri,
    range: { start: { line: 3, character: 57 }, end: { line: 3, character: 62 } },
    propertyName,
    propertyType: 'Color' as ShaderLabPropertyType,
    callKind: 'property-to-id',
    accessor: 'property-to-id',
    nameOrigin: 'direct',
    receiverType: 'Shader',
    expressionDeterminism: 'constant-string',
    bindingDeterminism: 'proven',
    shader: { name: shaderName, path: shaderPath },
    sourceRevision: { uri: csUri, contentHash },
    ...overrides,
  };
}

/**
 * Build a material-set usage (line 5: material.SetColor("_Tint", c)).
 * The name token "_Tint" sits at line 5, characters 27–32.
 */
function materialSetUsage(
  contentHash: string,
  overrides: Partial<AdapterCSharpPropertyUsage> = {},
): AdapterCSharpPropertyUsage {
  return {
    uri: csUri,
    range: { start: { line: 5, character: 27 }, end: { line: 5, character: 32 } },
    propertyName,
    propertyType: 'Color' as ShaderLabPropertyType,
    callKind: 'material-set',
    accessor: 'set-color',
    nameOrigin: 'direct',
    receiverType: 'Material',
    expressionDeterminism: 'constant-string',
    bindingDeterminism: 'proven',
    shader: { name: shaderName, path: shaderPath },
    sourceRevision: { uri: csUri, contentHash },
    ...overrides,
  };
}

function makeSource(
  usages: AdapterCSharpPropertyUsage[],
): CSharpPropertySource {
  return {
    identity: { projectId: 'project-a', instanceId: 'editor-1' },
    async csharpPropertyUsagesFor(_target: CSharpPropertyTarget) {
      return {
        assetScope: 'complete',
        revision: 'csharp-1',
        collectedAt: now,
        usages,
      };
    },
  };
}

/**
 * Mock current-source provider. The production client has no C# document
 * selector, so this provider is the only way the server can observe the
 * current C# source. Tests control it to prove the PropertyToID path and to
 * exercise stale / unknown / missing-provider rejection.
 */
function mockCurrentSourceProvider(
  text: string | null,
  availability: 'open-buffer' | 'closed-saved' = 'open-buffer',
): CSharpCurrentSourceProvider {
  return {
    async currentSourceFor(uri: string) {
      if (text === null) return null;
      if (uri !== csUri) return null;
      return {
        text,
        availability,
      };
    },
  };
}

async function handlerWithRegistry(
  registry: AdapterRegistry,
  currentSourceProvider: CSharpCurrentSourceProvider | undefined,
) {
  const shaderDocument = TextDocument.create(shaderUri, 'shaderlab', 1, shaderText);
  const documents = createDocumentRegistry(shaderDocument);
  const workspace = createIndexedWorkspaceFixture(
    [await indexFile(shaderUri, shaderText)],
    {
      csharpPropertyUsages: registry,
      csharpCurrentSource: currentSourceProvider,
    },
  );
  const { connection, handler } = captureReferencesHandler();
  registerReferencesHandler(connection, documents, {
    servingWorkspaceFor: (uri) => documents.snapshot(uri) ? workspace : undefined,
  });
  return handler();
}

async function registeredHandler(
  usages: AdapterCSharpPropertyUsage[],
  options: {
    currentSourceProvider?: CSharpCurrentSourceProvider | undefined;
    includeCapability?: boolean;
  } = {},
) {
  const registry = new AdapterRegistry({ now: () => now });
  if (options.includeCapability !== false) {
    registry.registerHandshake('project-a', handshake(), {
      csharpPropertyUsages: makeSource(usages),
    });
  }
  return handlerWithRegistry(
    registry,
    'currentSourceProvider' in options
      ? options.currentSourceProvider
      : mockCurrentSourceProvider(csText),
  );
}

function csharpLocations(
  locations: Location[] | null,
): CSharpPropertyReferenceLocation[] {
  return (locations ?? []).filter(
    (location): location is CSharpPropertyReferenceLocation => (
      'data' in location
      && location.data?.kind === 'csharp-property-usage'
    ),
  );
}

function uncertainCSharpLocations(
  locations: Location[] | null,
): CSharpPropertyUncertainLocation[] {
  return (locations ?? []).filter(
    (location): location is CSharpPropertyUncertainLocation => (
      'data' in location
      && location.data?.kind === 'csharp-property-uncertain'
    ),
  );
}

describe('C# Property usage References overlay (narrow prototype)', () => {
  it('returns proven PropertyToID and material-set call sites as authoritative references', async () => {
    const handler = await registeredHandler([
      propertyToIdUsage(sha256(csText)),
      materialSetUsage(sha256(csText)),
    ]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    const locations = csharpLocations(result);
    expect(locations).toHaveLength(2);
    const propertyToId = locations.find((l) => l.data.callKind === 'property-to-id');
    const materialSet = locations.find((l) => l.data.callKind === 'material-set');
    expect(propertyToId).toBeDefined();
    expect(propertyToId?.data).toMatchObject({
      propertyName,
      bindingDeterminism: 'proven',
      expressionDeterminism: 'constant-string',
      receiverType: 'Shader',
      shader: { name: shaderName, path: shaderPath },
    });
    expect(materialSet).toBeDefined();
    expect(materialSet?.data).toMatchObject({
      propertyName,
      bindingDeterminism: 'proven',
      expressionDeterminism: 'constant-string',
      receiverType: 'Material',
    });
  });

  it('keeps the source declaration reference alongside C# usages', async () => {
    const handler = await registeredHandler([propertyToIdUsage(sha256(csText))]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(result).not.toBeNull();
    expect(csharpLocations(result)).toHaveLength(1);
    const nonCSharp = (result ?? []).filter(
      (location) => !('data' in location && location.data?.kind === 'csharp-property-usage'),
    );
    expect(nonCSharp.length).toBeGreaterThan(0);
  });

  it('produces no authoritative reference when the current-source provider is missing', async () => {
    const handler = await registeredHandler(
      [propertyToIdUsage(sha256(csText))],
      { currentSourceProvider: undefined },
    );

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(0);
  });

  it('produces no authoritative reference when the current source is unknown', async () => {
    const handler = await registeredHandler(
      [propertyToIdUsage(sha256(csText))],
      { currentSourceProvider: mockCurrentSourceProvider(null) },
    );

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(0);
  });

  it('rejects a stale C# source whose content hash does not match', async () => {
    const staleText = csText + '\n// stale edit';
    const handler = await registeredHandler(
      [propertyToIdUsage(sha256(csText))],
      { currentSourceProvider: mockCurrentSourceProvider(staleText) },
    );

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(0);
  });

  it('accepts a closed-saved current source when the hash matches', async () => {
    const handler = await registeredHandler(
      [propertyToIdUsage(sha256(csText))],
      { currentSourceProvider: mockCurrentSourceProvider(csText, 'closed-saved') },
    );

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(1);
  });

  it('rejects a usage whose property name does not match the target', async () => {
    const handler = await registeredHandler([
      propertyToIdUsage(sha256(csText), { propertyName: '_Wrong' }),
    ]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(0);
  });

  it('rejects a proven usage whose shader name does not match the target', async () => {
    const handler = await registeredHandler([
      propertyToIdUsage(sha256(csText), {
        shader: { name: 'Tests/Other', path: shaderPath },
      }),
    ]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(0);
  });

  it('rejects a proven usage whose shader path does not match the target', async () => {
    const handler = await registeredHandler([
      propertyToIdUsage(sha256(csText), {
        shader: { name: shaderName, path: 'Assets/Other/Lit.shader' },
      }),
    ]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(0);
  });

  it('returns a name-only binding as uncertain evidence, never authoritative', async () => {
    const handler = await registeredHandler([
      propertyToIdUsage(sha256(csText), {
        bindingDeterminism: 'name-only',
        shader: null,
      }),
    ]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(0);
    expect(uncertainCSharpLocations(result)).toMatchObject([{
      data: {
        uncertaintyReason: 'binding-not-proven',
        bindingDeterminism: 'name-only',
      },
    }]);
  });

  it('returns a dynamic expression as uncertain evidence, never authoritative', async () => {
    const handler = await registeredHandler([
      materialSetUsage(sha256(csText), {
        expressionDeterminism: 'dynamic',
        nameOrigin: 'dynamic',
      }),
    ]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(csharpLocations(result)).toHaveLength(0);
    expect(uncertainCSharpLocations(result)).toMatchObject([{
      data: {
        uncertaintyReason: 'dynamic-property-name',
        expressionDeterminism: 'dynamic',
      },
    }]);
  });

  it('returns no C# locations when the Adapter is unavailable', async () => {
    const registry = new AdapterRegistry({ now: () => now });
    const handler = await handlerWithRegistry(
      registry,
      mockCurrentSourceProvider(csText),
    );

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    expect(result).not.toBeNull();
    expect(csharpLocations(result)).toHaveLength(0);
  });

  it('accepts a constant-concat expression when binding is proven', async () => {
    const handler = await registeredHandler([
      materialSetUsage(sha256(csText), { expressionDeterminism: 'constant-concat' }),
    ]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    const locations = csharpLocations(result);
    expect(locations).toHaveLength(1);
    expect(locations[0].data.expressionDeterminism).toBe('constant-concat');
  });

  it('resolves a PropertyToID-derived setter without exposing a numeric ID', async () => {
    const handler = await registeredHandler([
      materialSetUsage(sha256(csText), { nameOrigin: 'property-id' }),
    ]);

    const result = await handler({
      textDocument: { uri: shaderUri },
      position: { line: 2, character: 7 },
      context: { includeDeclaration: true },
    });

    const locations = csharpLocations(result);
    expect(locations).toHaveLength(1);
    expect(locations[0].data.nameOrigin).toBe('property-id');
    expect(locations[0].data).not.toHaveProperty('propertyId');
  });
});
