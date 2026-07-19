import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
  type AdapterHandshake,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type {
  ShaderGraphSource,
  ShaderGraphSourceSnapshot,
} from '../../src/adapter/shaderGraphSource';

const fixture = (name: string): ShaderGraphSourceSnapshot => JSON.parse(readFileSync(
  join(__dirname, 'fixtures', name),
  'utf8',
)) as ShaderGraphSourceSnapshot;

function handshake(now: number): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: now,
    instanceId: 'adapter-instance',
    capabilities: {
      unityVersion: '2021.3.45f1',
      projectId: 'project-a',
      adapterVersion: '0.4.0',
      supportedFeatures: [SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY],
    },
  };
}

describe('Shader Graph Adapter source', () => {
  it('stamps supported Shader Graph 10.8 Custom Function facts with trusted provenance', async () => {
    const now = 1_000;
    const source: ShaderGraphSource = {
      identity: { projectId: 'project-a', instanceId: 'adapter-instance' },
      async customFunctionNodes() {
        return fixture('shader-graph-10.8.json');
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(now), { shaderGraph: source });

    const result = await registry.shaderGraphCustomFunctions();

    expect(result).toEqual({
      availability: 'available',
      assetScope: 'complete',
      shaderGraphVersion: '10.8.0',
      revision: 'shader-graphs-10.8-r1',
      usages: [{
        nodeId: 'node-10',
        displayName: 'Build Waves',
        functionName: 'BuildWaves',
        precision: 'float',
        source: {
          uri: 'file:///project/Assets/Shaders/Waves.hlsl',
          assetGuid: 'hlsl-guid-10',
          path: 'Assets/Shaders/Waves.hlsl',
        },
        ports: [
          { name: 'UV', direction: 'input', type: 'float2' },
          { name: 'Out', direction: 'output', type: 'float3' },
        ],
        nodeRange: {
          start: { line: 4, character: 0 },
          end: { line: 18, character: 1 },
        },
        functionNameRange: {
          start: { line: 8, character: 20 },
          end: { line: 8, character: 30 },
        },
        sourceRange: {
          start: { line: 9, character: 18 },
          end: { line: 9, character: 49 },
        },
        provenance: {
          capability: SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
          adapterVersion: '0.4.0',
          unityVersion: '2021.3.45f1',
          projectId: 'project-a',
          instanceId: 'adapter-instance',
          collectedAt: now,
          shaderGraphVersion: '10.8.0',
          sourceRevision: {
            uri: 'file:///project/Assets/Graphs/Waves.shadergraph',
            assetGuid: 'graph-guid-10',
            contentHash: '1111111111111111111111111111111111111111111111111111111111111111',
          },
        },
      }],
    });
  });

  it('normalizes Shader Graph 16 facts through the same capability contract', async () => {
    const now = 1_000;
    const source: ShaderGraphSource = {
      identity: { projectId: 'project-a', instanceId: 'adapter-instance' },
      async customFunctionNodes() {
        return fixture('shader-graph-16.0.json');
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(now), { shaderGraph: source });

    const result = await registry.shaderGraphCustomFunctions();

    expect(result).toMatchObject({
      availability: 'available',
      assetScope: 'complete',
      shaderGraphVersion: '16.0.6',
      revision: 'shader-graphs-16.0-r1',
      usages: [{
        nodeId: 'node-16',
        functionName: 'ApplyFog',
        precision: 'half',
        ports: [
          { name: 'Color', direction: 'input', type: 'half3' },
          { name: 'Density', direction: 'input', type: 'half' },
          { name: 'Out', direction: 'output', type: 'half3' },
        ],
        provenance: {
          capability: SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
          shaderGraphVersion: '16.0.6',
          sourceRevision: {
            uri: 'file:///project/Assets/Graphs/Fog.shadergraph',
            assetGuid: 'graph-guid-16',
            contentHash: '2222222222222222222222222222222222222222222222222222222222222222',
          },
        },
      }],
    });
  });

  it('reports an unsupported Shader Graph version as capability status', async () => {
    const now = 1_000;
    const source: ShaderGraphSource = {
      identity: { projectId: 'project-a', instanceId: 'adapter-instance' },
      async customFunctionNodes() {
        return { status: 'unsupported-version', shaderGraphVersion: '18.2.0' };
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(now), { shaderGraph: source });

    await expect(registry.shaderGraphCustomFunctions()).resolves.toEqual({
      availability: 'unknown',
      assetScope: 'unknown',
      reason: 'shader-graph-version-unsupported',
      shaderGraphVersion: '18.2.0',
    });
  });

  it('does not query Shader Graph layouts without the advertised capability', async () => {
    const now = 1_000;
    const source: ShaderGraphSource = {
      identity: { projectId: 'project-a', instanceId: 'adapter-instance' },
      async customFunctionNodes() {
        throw new Error('capability gate must run before the version decoder');
      },
    };
    const withoutShaderGraph = handshake(now);
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', {
      ...withoutShaderGraph,
      capabilities: {
        ...withoutShaderGraph.capabilities,
        supportedFeatures: [],
      },
    }, { shaderGraph: source });

    await expect(registry.shaderGraphCustomFunctions()).resolves.toEqual({
      availability: 'unknown',
      assetScope: 'unknown',
      reason: 'capability-unavailable',
    });
  });

  it('keeps Adapter-unavailable fallback explicit and fact-free', async () => {
    const registry = new AdapterRegistry({ now: () => 1_000 });

    await expect(registry.shaderGraphCustomFunctions()).resolves.toEqual({
      availability: 'unknown',
      assetScope: 'unknown',
      reason: 'no-adapter',
    });
  });
});
