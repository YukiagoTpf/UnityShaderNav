import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  DEFAULT_SETTINGS,
  SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
  type AdapterHandshake,
  type ShaderGraphReferenceLocation,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type { ShaderGraphSource } from '../../src/adapter/shaderGraphSource';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { Workspace } from '../../src/workspace/workspace';

const now = 1_000;
const fakeConnection = {
  console: { log() {}, warn() {}, error() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function handshake(): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: now,
    instanceId: 'editor-1',
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      adapterVersion: '0.4.0',
      supportedFeatures: [SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY],
    },
  };
}

interface NavigationFixture {
  readonly root: string;
  readonly workspace: Workspace;
  readonly hlslUri: string;
  readonly hlslText: string;
  readonly graphUri: string;
  readonly graphDocument: IndexedDocumentSnapshot;
}

async function createNavigationFixture(): Promise<NavigationFixture> {
  const root = await mkdtemp(join(tmpdir(), 'usn-shader-graph-navigation-'));
  const hlslPath = join(root, 'Assets', 'Shaders', 'Waves.hlsl');
  const graphPath = join(root, 'Assets', 'Graphs', 'Waves.shadergraph');
  await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
  await mkdir(join(root, 'Assets', 'Graphs'), { recursive: true });
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
  await writeFile(
    join(root, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 2022.3.62f1\n',
  );
  const hlslText = [
    'void BuildWaves_float(float2 UV, out float3 Out) {',
    '  Out = float3(UV, 0);',
    '}',
  ].join('\n');
  const graphText = [
    'graph',
    'node BuildWaves',
    'source Assets/Shaders/Waves.hlsl',
  ].join('\n');
  await writeFile(hlslPath, hlslText);
  await writeFile(graphPath, graphText);
  const hlslUri = pathToFileURL(hlslPath).href;
  const graphUri = pathToFileURL(graphPath).href;
  const source: ShaderGraphSource = {
    identity: { projectId: 'project-a', instanceId: 'editor-1' },
    async customFunctionNodes() {
      return {
        status: 'available',
        shaderGraphVersion: '16.0.6',
        revision: 'graphs-r1',
        collectedAt: now,
        assets: [{
          sourceRevision: {
            uri: graphUri,
            assetGuid: 'graph-guid',
            contentHash: hash(graphText),
          },
          nodes: [{
            nodeId: 'node-1',
            displayName: 'Build Waves',
            functionName: 'BuildWaves',
            precision: 'float',
            source: {
              uri: hlslUri,
              assetGuid: 'hlsl-guid',
              path: 'Assets/Shaders/Waves.hlsl',
            },
            ports: [
              { name: 'UV', direction: 'input', type: 'float2' },
              { name: 'Out', direction: 'output', type: 'float3' },
            ],
            nodeRange: {
              start: { line: 0, character: 0 },
              end: { line: 2, character: 32 },
            },
            functionNameRange: {
              start: { line: 1, character: 5 },
              end: { line: 1, character: 15 },
            },
            sourceRange: {
              start: { line: 2, character: 7 },
              end: { line: 2, character: 32 },
            },
          }],
        }],
      };
    },
  };
  const registry = new AdapterRegistry({ now: () => now });
  registry.registerHandshake('project-a', handshake(), { shaderGraph: source });
  const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
    shaderGraphUsages: registry,
    releaseVersion: null,
  });
  await workspace.initialize(fakeConnection);
  return {
    root,
    workspace,
    hlslUri,
    hlslText,
    graphUri,
    graphDocument: {
      uri: graphUri,
      languageId: 'shadergraph',
      text: graphText,
      openId: 1,
      version: 1,
    },
  };
}

describe('Workspace Shader Graph navigation', () => {
  it('keeps raw Shader Graph assets outside the source index when the Adapter is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-shader-graph-fallback-'));
    const graphUri = pathToFileURL(join(root, 'Guess.shadergraph')).href;
    const document: IndexedDocumentSnapshot = {
      uri: graphUri,
      languageId: 'shadergraph',
      text: '{"m_FunctionName":"DoNotGuess","m_Source":"Fake.hlsl"}',
      openId: 1,
      version: 1,
    };
    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
      ensureParserReady: async () => {},
      releaseVersion: null,
    });
    try {
      await workspace.initialize(fakeConnection);

      await expect(workspace.updateDocument(document)).resolves.toBe(true);
      await expect(workspace.definitionAt({
        document,
        position: { line: 0, character: 20 },
      })).resolves.toBeNull();
      await expect(workspace.diagnosticsAt(document)).resolves.toEqual([]);
      expect(workspace.containsIndexedUri(graphUri)).toBe(false);
    } finally {
      workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('opens the precision-suffixed HLSL declaration from Adapter graph evidence', async () => {
    const fixture = await createNavigationFixture();
    try {
      const result = await fixture.workspace.definitionAt({
        document: fixture.graphDocument,
        position: { line: 1, character: 8 },
      });

      expect(result).toEqual([expect.objectContaining({
        targetUri: fixture.hlslUri,
        targetRange: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 21 },
        },
        targetSelectionRange: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 21 },
        },
        originSelectionRange: {
          start: { line: 1, character: 5 },
          end: { line: 1, character: 15 },
        },
        data: expect.objectContaining({
          kind: 'shader-graph-custom-function',
          provenance: expect.objectContaining({
            capability: SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
            sourceRevision: expect.objectContaining({ uri: fixture.graphUri }),
          }),
        }),
      })]);
    } finally {
      fixture.workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('includes the Adapter graph node when finding references from HLSL', async () => {
    const fixture = await createNavigationFixture();
    try {
      const document: IndexedDocumentSnapshot = {
        uri: fixture.hlslUri,
        languageId: 'hlsl',
        text: fixture.hlslText,
        openId: 2,
        version: 1,
      };

      const result = await fixture.workspace.referencesAt({
        document,
        position: { line: 0, character: 8 },
        includeDeclaration: true,
      });
      const graphReference = result?.find(
        (location): location is ShaderGraphReferenceLocation => (
          location.uri === fixture.graphUri && 'data' in location
        ),
      );

      expect(graphReference).toEqual({
        uri: fixture.graphUri,
        range: {
          start: { line: 1, character: 5 },
          end: { line: 1, character: 15 },
        },
        data: expect.objectContaining({
          kind: 'shader-graph-custom-function',
          node: { id: 'node-1', displayName: 'Build Waves' },
          functionName: 'BuildWaves',
          precision: 'float',
          provenance: expect.objectContaining({
            capability: SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
            shaderGraphVersion: '16.0.6',
            sourceRevision: expect.objectContaining({
              uri: fixture.graphUri,
              assetGuid: 'graph-guid',
            }),
          }),
        }),
      });
    } finally {
      fixture.workspace.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports focused missing-source, suffix, and port-signature diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-shader-graph-diagnostics-'));
    try {
      const hlslPath = join(root, 'Assets', 'Shaders', 'Waves.hlsl');
      const missingPath = join(root, 'Assets', 'Shaders', 'Missing.hlsl');
      const graphPath = join(root, 'Assets', 'Graphs', 'Broken.shadergraph');
      await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
      await mkdir(join(root, 'Assets', 'Graphs'), { recursive: true });
      await mkdir(join(root, 'Packages'), { recursive: true });
      await mkdir(join(root, 'ProjectSettings'), { recursive: true });
      await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
      await writeFile(
        join(root, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 2022.3.62f1\n',
      );
      await writeFile(hlslPath, 'void BuildWaves_float(float2 UV, out float3 Out) {}\n');
      const graphText = [
        'graph',
        'missing MissingFn',
        'suffix BuildWaves_float',
        'mismatch BuildWaves',
      ].join('\n');
      await writeFile(graphPath, graphText);
      const hlslUri = pathToFileURL(hlslPath).href;
      const graphUri = pathToFileURL(graphPath).href;
      const node = (
        nodeId: string,
        displayName: string,
        functionName: string,
        line: number,
        start: number,
        sourceUri: string,
        sourcePath: string,
        outputType = 'float3',
      ) => ({
        nodeId,
        displayName,
        functionName,
        precision: 'float' as const,
        source: { uri: sourceUri, assetGuid: `${nodeId}-source`, path: sourcePath },
        ports: [
          { name: 'UV', direction: 'input' as const, type: 'float2' },
          { name: 'Out', direction: 'output' as const, type: outputType },
        ],
        nodeRange: {
          start: { line, character: 0 },
          end: { line, character: graphText.split('\n')[line].length },
        },
        functionNameRange: {
          start: { line, character: start },
          end: { line, character: start + functionName.length },
        },
        sourceRange: {
          start: { line, character: 0 },
          end: { line, character: start },
        },
      });
      const source: ShaderGraphSource = {
        identity: { projectId: 'project-a', instanceId: 'editor-1' },
        async customFunctionNodes() {
          return {
            status: 'available',
            shaderGraphVersion: '16.0.6',
            revision: 'graphs-broken-r1',
            collectedAt: now,
            assets: [{
              sourceRevision: {
                uri: graphUri,
                assetGuid: 'broken-graph-guid',
                contentHash: hash(graphText),
              },
              nodes: [
                node(
                  'missing',
                  'Missing Function',
                  'MissingFn',
                  1,
                  8,
                  pathToFileURL(missingPath).href,
                  'Assets/Shaders/Missing.hlsl',
                ),
                node(
                  'suffix',
                  'Suffixed Function',
                  'BuildWaves_float',
                  2,
                  7,
                  hlslUri,
                  'Assets/Shaders/Waves.hlsl',
                ),
                node(
                  'mismatch',
                  'Mismatched Ports',
                  'BuildWaves',
                  3,
                  9,
                  hlslUri,
                  'Assets/Shaders/Waves.hlsl',
                  'float4',
                ),
              ],
            }],
          };
        },
      };
      const registry = new AdapterRegistry({ now: () => now });
      registry.registerHandshake('project-a', handshake(), { shaderGraph: source });
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        shaderGraphUsages: registry,
        releaseVersion: null,
      });
      await workspace.initialize(fakeConnection);
      const document: IndexedDocumentSnapshot = {
        uri: graphUri,
        languageId: 'shadergraph',
        text: graphText,
        openId: 3,
        version: 1,
      };

      const diagnostics = await workspace.diagnosticsAt(document);

      expect(diagnostics?.map(({ code, range, source: diagnosticSource }) => ({
        code,
        range,
        source: diagnosticSource,
      }))).toEqual([
        {
          code: 'shader-graph-source-missing',
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 8 },
          },
          source: 'Unity Shader Graph [Adapter] (Unity 2022.3.62f1, Shader Graph 16.0.6)',
        },
        {
          code: 'shader-graph-invalid-precision-suffix',
          range: {
            start: { line: 2, character: 7 },
            end: { line: 2, character: 23 },
          },
          source: 'Unity Shader Graph [Adapter] (Unity 2022.3.62f1, Shader Graph 16.0.6)',
        },
        {
          code: 'shader-graph-signature-mismatch',
          range: {
            start: { line: 3, character: 9 },
            end: { line: 3, character: 19 },
          },
          source: 'Unity Shader Graph [Adapter] (Unity 2022.3.62f1, Shader Graph 16.0.6)',
        },
      ]);
      expect(diagnostics?.map((diagnostic) => diagnostic.message)).toEqual([
        expect.stringContaining("missing include 'Assets/Shaders/Missing.hlsl'"),
        expect.stringContaining("must omit the precision suffix '_float'"),
        expect.stringContaining('expected void BuildWaves_float(float2 UV, out float4 Out)'),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
