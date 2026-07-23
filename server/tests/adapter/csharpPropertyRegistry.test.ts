import { describe, expect, it } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
  type AdapterHandshake,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type {
  AdapterCSharpPropertyUsage,
  CSharpPropertySource,
  CSharpPropertyTarget,
} from '../../src/adapter/csharpPropertySource';

const now = 1_000_000;
const csUri = 'file:///project/Assets/Scripts/ShaderController.cs';
const contentHash = 'a'.repeat(64);

const target: CSharpPropertyTarget = {
  shaderName: 'Tests/Lit',
  shaderPath: 'Assets/Shaders/Lit.shader',
  propertyName: '_Tint',
};

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

function handshakeWithoutCapability(instanceId = 'editor-1'): AdapterHandshake {
  return {
    ...handshake(instanceId),
    capabilities: {
      ...handshake(instanceId).capabilities,
      supportedFeatures: [],
    },
  };
}

function validUsage(
  overrides: Partial<AdapterCSharpPropertyUsage> = {},
): AdapterCSharpPropertyUsage {
  return {
    uri: csUri,
    range: { start: { line: 3, character: 57 }, end: { line: 3, character: 62 } },
    propertyName: '_Tint',
    propertyType: 'Color',
    callKind: 'property-to-id',
    accessor: 'property-to-id',
    nameOrigin: 'direct',
    receiverType: 'Shader',
    expressionDeterminism: 'constant-string',
    bindingDeterminism: 'proven',
    shader: { name: 'Tests/Lit', path: 'Assets/Shaders/Lit.shader' },
    sourceRevision: { uri: csUri, contentHash },
    ...overrides,
  };
}

function makeSource(
  usages: AdapterCSharpPropertyUsage[],
): CSharpPropertySource {
  return {
    identity: { projectId: 'project-a', instanceId: 'editor-1' },
    async csharpPropertyUsagesFor() {
      return {
        assetScope: 'complete',
        revision: 'csharp-1',
        collectedAt: now,
        usages,
      };
    },
  };
}

function registryWithSource(
  usages: AdapterCSharpPropertyUsage[],
  options: { includeCapability?: boolean; projectId?: string } = {},
): AdapterRegistry {
  const registry = new AdapterRegistry({ now: () => now });
  if (options.includeCapability !== false) {
    registry.registerHandshake(
      options.projectId ?? 'project-a',
      handshake(),
      { csharpPropertyUsages: makeSource(usages) },
    );
  }
  return registry;
}

describe('AdapterRegistry C# property usages validation', () => {
  it('passes a valid usage and stamps provenance', async () => {
    const registry = registryWithSource([validUsage()]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(1);
    expect(result.usages[0].provenance).toMatchObject({
      capability: CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
      projectId: 'project-a',
      instanceId: 'editor-1',
    });
  });

  it('rejects a usage with a foreign property name', async () => {
    const registry = registryWithSource([
      validUsage({ propertyName: '_Wrong' }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a proven usage with a foreign shader name', async () => {
    const registry = registryWithSource([
      validUsage({ shader: { name: 'Tests/Other', path: 'Assets/Shaders/Lit.shader' } }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a proven usage with a foreign shader path', async () => {
    const registry = registryWithSource([
      validUsage({ shader: { name: 'Tests/Lit', path: 'Assets/Other/Lit.shader' } }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a proven usage with a non-matching source revision URI', async () => {
    const registry = registryWithSource([
      validUsage({ sourceRevision: { uri: 'file:///other/Scripts/Other.cs', contentHash } }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a usage with a malformed content hash', async () => {
    const registry = registryWithSource([
      validUsage({ sourceRevision: { uri: csUri, contentHash: 'not-a-sha256' } }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a usage with an invalid callKind', async () => {
    const registry = registryWithSource([
      validUsage({ callKind: 'shader-find' as AdapterCSharpPropertyUsage['callKind'] }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects an accessor that does not match the call kind', async () => {
    const registry = registryWithSource([
      validUsage({ callKind: 'material-set', accessor: 'get-color' }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('accepts a PropertyToID-derived setter without a numeric ID contract', async () => {
    const registry = registryWithSource([
      validUsage({
        callKind: 'material-set',
        accessor: 'set-color',
        nameOrigin: 'property-id',
        receiverType: 'Material',
      }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(1);
    expect(result.usages[0].nameOrigin).toBe('property-id');
    expect(result.usages[0]).not.toHaveProperty('propertyId');
  });

  it('rejects a dynamic expression that claims a direct name origin', async () => {
    const registry = registryWithSource([
      validUsage({ expressionDeterminism: 'dynamic', nameOrigin: 'direct' }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a proven usage with a shader on a name-only binding', async () => {
    const registry = registryWithSource([
      validUsage({
        bindingDeterminism: 'name-only',
        shader: { name: 'Tests/Lit', path: 'Assets/Shaders/Lit.shader' },
      }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('accepts a name-only usage without a shader identity', async () => {
    const registry = registryWithSource([
      validUsage({ bindingDeterminism: 'name-only', shader: null }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    // Name-only usages pass structural validation; authoritative filtering
    // happens in the Workspace overlay.
    expect(result.usages).toHaveLength(1);
    expect(result.usages[0].bindingDeterminism).toBe('name-only');
  });

  it('returns unknown when the Adapter is unavailable', async () => {
    const registry = new AdapterRegistry({ now: () => now });
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('unknown');
  });

  it('returns unknown when the capability is not advertised', async () => {
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshakeWithoutCapability(), {});
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('unknown');
    if (result.availability === 'unknown') {
      expect(result.reason).toBe('capability-unavailable');
    }
  });

  it('returns unknown on source identity mismatch', async () => {
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), {
      csharpPropertyUsages: {
        identity: { projectId: 'different-project', instanceId: 'editor-1' },
        async csharpPropertyUsagesFor() {
          return {
            assetScope: 'complete',
            revision: 'csharp-1',
            collectedAt: now,
            usages: [validUsage()],
          };
        },
      },
    });
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('unknown');
    if (result.availability === 'unknown') {
      expect(result.reason).toBe('source-identity-mismatch');
    }
  });

  it('rejects a usage with a negative line coordinate', async () => {
    const registry = registryWithSource([
      validUsage({ range: { start: { line: -1, character: 0 }, end: { line: 3, character: 5 } } }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a usage with a decimal character coordinate', async () => {
    const registry = registryWithSource([
      validUsage({ range: { start: { line: 3, character: 1.5 }, end: { line: 3, character: 5 } } }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a usage where start character exceeds end on the same line', async () => {
    const registry = registryWithSource([
      validUsage({ range: { start: { line: 3, character: 10 }, end: { line: 3, character: 5 } } }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a usage with an undefined propertyType', async () => {
    const registry = registryWithSource([
      validUsage({ propertyType: undefined as unknown as AdapterCSharpPropertyUsage['propertyType'] }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a usage with an undefined receiverType', async () => {
    const registry = registryWithSource([
      validUsage({ receiverType: undefined as unknown as string }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('rejects a non-proven usage with an undefined shader (not null)', async () => {
    const registry = registryWithSource([
      validUsage({
        bindingDeterminism: 'name-only',
        shader: undefined as unknown as null,
      }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    expect(result.usages).toHaveLength(0);
  });

  it('accepts a non-proven usage with an explicitly null shader', async () => {
    const registry = registryWithSource([
      validUsage({ bindingDeterminism: 'name-only', shader: null }),
    ]);
    const result = await registry.csharpPropertyUsagesFor(target);
    expect(result.availability).toBe('available');
    if (result.availability !== 'available') return;
    // Name-only usages pass structural validation; authoritative filtering
    // happens in the Workspace overlay.
    expect(result.usages).toHaveLength(1);
    expect(result.usages[0].bindingDeterminism).toBe('name-only');
  });
});
