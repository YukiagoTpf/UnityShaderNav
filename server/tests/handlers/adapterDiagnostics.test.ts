import { describe, expect, it, vi } from 'vitest';
import {
  DiagnosticSeverity,
  type Connection,
  type Diagnostic,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import type {
  AdapterDiagnostic,
  CompileProfile,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import {
  registerAdapterDiagnosticOverlay,
  shaderSourceHash,
} from '../../src/handlers/adapterDiagnostics';
import { registerDiagnosticsPublisher } from '../../src/handlers/diagnostics';
import { registerDocuments } from '../../src/handlers/documents';
import type { IndexedWorkspace } from '../../src/workspace/indexedWorkspace';

const URI = 'file:///project/Assets/Current.shader';
const SOURCE = [
  'Shader "Current" {',
  '  SubShader {',
  '    missing',
  '  }',
  '}',
].join('\n');

const D3D_PROFILE: CompileProfile = {
  name: 'd3d11',
  platform: 'StandaloneWindows64',
  graphicsApi: 'Direct3D11',
  capability: 'compile-profile/d3d11',
};

const VULKAN_PROFILE: CompileProfile = {
  name: 'vulkan',
  platform: 'StandaloneLinux64',
  graphicsApi: 'Vulkan',
  capability: 'compile-profile/vulkan',
};

type OpenHandler = (event: {
  textDocument: { uri: string; languageId: string; version: number; text: string };
}) => void;
type ChangeHandler = (event: {
  textDocument: { uri: string; version: number };
  contentChanges: { text: string }[];
}) => void;
type SaveHandler = (event: { textDocument: { uri: string } }) => void;
type CloseHandler = (event: { textDocument: { uri: string } }) => void;

function connectionHarness(): {
  readonly connection: Connection;
  readonly sends: PublishDiagnosticsParams[];
  open(event: Parameters<OpenHandler>[0]): void;
  change(event: Parameters<ChangeHandler>[0]): void;
  save(event: Parameters<SaveHandler>[0]): void;
  close(event: Parameters<CloseHandler>[0]): void;
} {
  let open: OpenHandler | undefined;
  let change: ChangeHandler | undefined;
  let save: SaveHandler | undefined;
  let close: CloseHandler | undefined;
  const sends: PublishDiagnosticsParams[] = [];
  const disposable = { dispose() {} };
  const connection = {
    console: { log() {}, error: vi.fn() },
    onDidOpenTextDocument(handler: OpenHandler) {
      open = handler;
      return disposable;
    },
    onDidChangeTextDocument(handler: ChangeHandler) {
      change = handler;
      return disposable;
    },
    onDidCloseTextDocument(handler: CloseHandler) {
      close = handler;
      return disposable;
    },
    onWillSaveTextDocument() { return disposable; },
    onWillSaveTextDocumentWaitUntil() { return disposable; },
    onDidSaveTextDocument(handler: SaveHandler) {
      save = handler;
      return disposable;
    },
    async sendDiagnostics(params: PublishDiagnosticsParams) {
      sends.push(params);
    },
  } as unknown as Connection;
  return {
    connection,
    sends,
    open: (event) => open?.(event),
    change: (event) => change?.(event),
    save: (event) => save?.(event),
    close: (event) => close?.(event),
  };
}

interface CompilerDiagnosticOptions {
  readonly source?: string;
  readonly uri?: string;
  readonly instanceId?: string;
  readonly projectId?: string;
  readonly severity?: 'error' | 'warning';
  readonly line?: number;
  readonly message?: string;
  readonly platform?: string;
}

function compilerDiagnostic(options: CompilerDiagnosticOptions = {}): AdapterDiagnostic {
  const source = options.source ?? SOURCE;
  const uri = options.uri ?? URI;
  return {
    shaderMessage: {
      message: options.message ?? "undeclared identifier 'missing'",
      messageDetails: 'at fragment program',
      file: 'Assets/Current.shader',
      line: options.line ?? 3,
      severity: options.severity ?? 'error',
      platform: options.platform ?? 'd3d11',
    },
    provenance: {
      capability: 'shader-messages',
      adapterVersion: '0.1.0',
      unityVersion: '2022.3.62f1',
      projectId: options.projectId ?? 'project-a',
      instanceId: options.instanceId ?? 'instance-a',
      collectedAt: 1_000_000,
      sourceRevision: {
        uri,
        assetGuid: 'asset-guid',
        contentHash: shaderSourceHash(source),
      },
    },
  };
}

async function flush(times = 24): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const STATIC_DIAGNOSTIC: Diagnostic = {
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 6 },
  },
  message: 'static issue',
  source: 'UnityShaderNav',
};

interface TestMessageSource {
  getShaderMessages(
    documentUri: string,
    profile: CompileProfile,
  ): Promise<readonly AdapterDiagnostic[]>;
}

function scenario(
  source: TestMessageSource,
  options: {
    readonly connectedBeforeRegistration?: boolean;
    readonly staticDiagnostics?: readonly Diagnostic[];
    readonly profiles?: readonly CompileProfile[];
    readonly selectedProfile?: CompileProfile | null;
  } = {},
) {
  const profiles = options.profiles ?? [D3D_PROFILE];
  const selectedProfile = options.selectedProfile === null
    ? undefined
    : options.selectedProfile ?? D3D_PROFILE;
  const registry = new AdapterRegistry({
    now: () => 1_000_000,
    messageSource: source,
    profileSource: {
      getCompileProfiles: async () => profiles,
    },
  });
  const connect = (
    instanceId = 'instance-a',
    projectId = 'project-a',
    expectedProjectId = 'project-a',
  ) => registry.registerHandshake(expectedProjectId, {
    interfaceVersion: 1,
    issuedAt: 1_000_000,
    instanceId,
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId,
      adapterVersion: '0.1.0',
      supportedFeatures: [
        'shader-messages',
        ...profiles.map((profile) => profile.capability),
      ],
    },
  });
  if (options.connectedBeforeRegistration !== false) connect();

  const harness = connectionHarness();
  const workspace = {
    updateDocument: vi.fn(async () => true),
    closeDocument: vi.fn(async () => {}),
    diagnosticsAt: vi.fn(async () => [...(options.staticDiagnostics ?? [STATIC_DIAGNOSTIC])]),
  } as unknown as IndexedWorkspace;
  const manager = {
    workspaceFor: () => workspace,
    servingWorkspaceFor: () => workspace,
    workspaceForOrCreateFile: vi.fn(async () => workspace),
    releaseDocument: vi.fn(async () => {}),
    configureOpenDocumentsProvider: vi.fn(),
    configureDiagnosticsRefresh: vi.fn(),
  };
  const documents = registerDocuments(harness.connection, manager as never);
  const adapter = registerAdapterDiagnosticOverlay(
    harness.connection,
    documents,
    registry,
    selectedProfile,
  );
  registerDiagnosticsPublisher(
    harness.connection,
    documents,
    manager as never,
    [adapter],
  );

  return {
    ...harness,
    adapter,
    connect,
    documents,
    registry,
    open(uri = URI, text = SOURCE, version = 1): void {
      harness.open({
        textDocument: { uri, languageId: 'shaderlab', version, text },
      });
    },
    save(uri = URI): void {
      harness.save({ textDocument: { uri } });
    },
  };
}

describe('Adapter compiler diagnostics', () => {
  it('keeps the static path untouched when the Adapter is unavailable', async () => {
    const source = { getShaderMessages: vi.fn(async () => [compilerDiagnostic()]) };
    const harness = scenario(source, { connectedBeforeRegistration: false });

    harness.open();
    harness.save();
    await flush();
    const document = harness.documents.snapshot(URI);
    if (!document) throw new Error('expected an open document snapshot');

    expect(source.getShaderMessages).not.toHaveBeenCalled();
    expect(harness.adapter.profileStatusesFor(document)).toEqual([{
      status: 'adapter-unavailable',
      requestedProfile: D3D_PROFILE,
      reason: 'no-adapter',
    }]);
    expect(harness.sends).toEqual([]);
  });

  it('refreshes one saved Compute Shader without requesting other assets', async () => {
    const uri = 'file:///project/Assets/Current.compute';
    const sourceText = '#pragma kernel CSMain\n[numthreads(1,1,1)] void CSMain() {}';
    const source = {
      getShaderMessages: vi.fn(async () => [compilerDiagnostic({
        uri,
        source: sourceText,
      })]),
    };
    const harness = scenario(source, { staticDiagnostics: [] });
    harness.open(uri, sourceText);
    harness.save(uri);
    await flush();

    expect(source.getShaderMessages).toHaveBeenCalledOnce();
    expect(source.getShaderMessages).toHaveBeenCalledWith(
      uri,
      D3D_PROFILE,
      expect.any(AbortSignal),
    );
    expect(harness.sends.at(-1)).toMatchObject({ uri, version: 1 });
  });

  it('does not request standalone include files that Unity cannot compile as assets', async () => {
    const uri = 'file:///project/Assets/Common.hlsl';
    const source = { getShaderMessages: vi.fn(async () => []) };
    const harness = scenario(source);
    harness.open(uri, 'float4 Common() { return 0; }');
    harness.save(uri);
    await flush();

    expect(source.getShaderMessages).not.toHaveBeenCalled();
    expect(harness.sends).toEqual([]);
  });

  it('publishes a saved current-asset error beside static diagnostics with provenance', async () => {
    const source = { getShaderMessages: vi.fn(async () => [compilerDiagnostic()]) };
    const harness = scenario(source);

    harness.open();
    harness.save();
    await flush();

    expect(source.getShaderMessages).toHaveBeenCalledOnce();
    expect(source.getShaderMessages).toHaveBeenCalledWith(
      URI,
      D3D_PROFILE,
      expect.any(AbortSignal),
    );
    expect(harness.sends).toEqual([{
      uri: URI,
      version: 1,
      diagnostics: [
        STATIC_DIAGNOSTIC,
        expect.objectContaining({
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 11 },
          },
          severity: DiagnosticSeverity.Error,
          message: "undeclared identifier 'missing'\nat fragment program",
          source: 'Unity Shader Compiler [d3d11] (Unity 2022.3.62f1, StandaloneWindows64, Direct3D11)',
          data: {
            kind: 'adapter-diagnostic',
            shaderMessage: compilerDiagnostic().shaderMessage,
            provenance: compilerDiagnostic().provenance,
            profile: D3D_PROFILE,
          },
        }),
      ],
    }]);
  });

  it('groups diagnostics by selected profile without dropping Unity message context', async () => {
    const source = {
      getShaderMessages: vi.fn(async (
        _documentUri: string,
        profile: CompileProfile,
      ) => [compilerDiagnostic({
        message: `${profile.name} failure`,
        platform: profile.graphicsApi,
      })]),
    };
    const harness = scenario(source, {
      staticDiagnostics: [],
      profiles: [D3D_PROFILE, VULKAN_PROFILE],
    });
    harness.open();
    harness.save();
    await flush();

    harness.adapter.selectProfile(VULKAN_PROFILE);
    await flush(40);

    expect(harness.sends.at(-1)?.diagnostics).toEqual([
      expect.objectContaining({
        source: 'Unity Shader Compiler [d3d11] (Unity 2022.3.62f1, StandaloneWindows64, Direct3D11)',
        message: expect.stringContaining('d3d11 failure\nat fragment program'),
        data: expect.objectContaining({
          kind: 'context-diagnostic-group',
          affectedContextCount: 1,
          analyzedContextCount: 2,
          affectedContexts: [expect.objectContaining({
            provenances: [expect.objectContaining({
              kind: 'compiler',
              profile: D3D_PROFILE,
              shaderMessage: expect.objectContaining({
                messageDetails: 'at fragment program',
                platform: 'Direct3D11',
              }),
            })],
          })],
        }),
      }),
      expect.objectContaining({
        source: 'Unity Shader Compiler [vulkan] (Unity 2022.3.62f1, StandaloneLinux64, Vulkan)',
        message: expect.stringContaining('vulkan failure\nat fragment program'),
        data: expect.objectContaining({
          kind: 'context-diagnostic-group',
          affectedContextCount: 1,
          analyzedContextCount: 2,
          affectedContexts: [expect.objectContaining({
            provenances: [expect.objectContaining({
              kind: 'compiler',
              profile: VULKAN_PROFILE,
              shaderMessage: expect.objectContaining({
                messageDetails: 'at fragment program',
                platform: 'Vulkan',
              }),
            })],
          })],
        }),
      }),
    ]);
  });

  it('aggregates an equivalent compiler finding across analyzed profiles', async () => {
    const source = {
      getShaderMessages: vi.fn(async () => [compilerDiagnostic()]),
    };
    const harness = scenario(source, {
      staticDiagnostics: [],
      profiles: [D3D_PROFILE, VULKAN_PROFILE],
    });
    harness.open();
    harness.save();
    await flush();

    harness.adapter.selectProfile(VULKAN_PROFILE);
    await flush(40);

    expect(harness.sends.at(-1)?.diagnostics).toHaveLength(1);
    expect(harness.sends.at(-1)?.diagnostics[0]).toMatchObject({
      source: 'Unity Shader Compiler (aggregated)',
      message: expect.stringContaining(
        'Affected in 2 of 2 analyzed Shader Contexts.',
      ),
      data: {
        kind: 'context-diagnostic-group',
        affectedContextCount: 2,
        analyzedContextCount: 2,
        knownContextCount: 2,
        unverifiedContextCount: 0,
        affectedContexts: [
          {
            context: expect.objectContaining({
              shader: {
                status: 'verified',
                value: { uri: URI },
              },
              pass: {
                status: 'unverified',
                reason: 'compiler-message-not-context-scoped',
              },
              stage: {
                status: 'unverified',
                reason: 'compiler-message-not-context-scoped',
              },
              keywords: {
                status: 'unverified',
                reason: 'compiler-message-not-context-scoped',
              },
              platform: {
                status: 'verified',
                value: D3D_PROFILE.platform,
              },
              graphicsApi: {
                status: 'verified',
                value: D3D_PROFILE.graphicsApi,
              },
              profile: { status: 'verified', value: D3D_PROFILE },
            }),
            provenances: [{
              kind: 'compiler',
              profile: D3D_PROFILE,
              shaderMessage: compilerDiagnostic().shaderMessage,
              envelope: compilerDiagnostic().provenance,
            }],
          },
          expect.objectContaining({
            context: expect.objectContaining({
              platform: {
                status: 'verified',
                value: VULKAN_PROFILE.platform,
              },
              graphicsApi: {
                status: 'verified',
                value: VULKAN_PROFILE.graphicsApi,
              },
              profile: { status: 'verified', value: VULKAN_PROFILE },
            }),
          }),
        ],
      },
    });
    expect(harness.sends.at(-1)?.diagnostics[0].relatedInformation).toHaveLength(2);
  });

  it('analyzes the bounded discovered profile set without manual switching', async () => {
    const source = {
      getShaderMessages: vi.fn(async () => [compilerDiagnostic()]),
    };
    const harness = scenario(source, {
      staticDiagnostics: [],
      profiles: [D3D_PROFILE, VULKAN_PROFILE],
      selectedProfile: null,
    });

    harness.open();
    harness.save();
    await flush(80);

    expect(source.getShaderMessages).toHaveBeenCalledTimes(2);
    expect(source.getShaderMessages.mock.calls.map(([, profile]) => profile)).toEqual([
      D3D_PROFILE,
      VULKAN_PROFILE,
    ]);
    expect(harness.sends.at(-1)?.diagnostics).toHaveLength(1);
    expect(harness.sends.at(-1)?.diagnostics[0]).toMatchObject({
      message: expect.stringContaining(
        'Affected in 2 of 2 analyzed Shader Contexts.',
      ),
      data: expect.objectContaining({
        affectedContextCount: 2,
        analyzedContextCount: 2,
        knownContextCount: 2,
      }),
    });
  });

  it('reports Auto coverage even when the Adapter exposes one profile', async () => {
    const source = {
      getShaderMessages: vi.fn(async () => [compilerDiagnostic()]),
    };
    const harness = scenario(source, {
      staticDiagnostics: [],
      profiles: [D3D_PROFILE],
      selectedProfile: null,
    });

    harness.open();
    harness.save();
    await flush(40);

    expect(harness.sends.at(-1)?.diagnostics).toHaveLength(1);
    expect(harness.sends.at(-1)?.diagnostics[0]).toMatchObject({
      message: expect.stringContaining(
        'Affected in 1 of 1 analyzed Shader Context.',
      ),
      data: expect.objectContaining({
        kind: 'context-diagnostic-group',
        affectedContextCount: 1,
        analyzedContextCount: 1,
        knownContextCount: 1,
      }),
    });
  });

  it('reports a failed profile as unverified beside the surviving finding', async () => {
    const source = {
      getShaderMessages: vi.fn((
        _documentUri: string,
        profile: CompileProfile,
      ) => profile.name === D3D_PROFILE.name
        ? Promise.resolve([compilerDiagnostic()])
        : Promise.reject(new Error('compiler unavailable'))),
    };
    const harness = scenario(source, {
      staticDiagnostics: [],
      profiles: [D3D_PROFILE, VULKAN_PROFILE],
    });
    harness.open();
    harness.save();
    await flush();

    harness.adapter.selectProfile(VULKAN_PROFILE);
    await flush(40);

    expect(harness.sends.at(-1)?.diagnostics).toHaveLength(1);
    expect(harness.sends.at(-1)?.diagnostics[0]).toMatchObject({
      message: expect.stringContaining('1 additional Context unverified.'),
      data: {
        kind: 'context-diagnostic-group',
        affectedContextCount: 1,
        analyzedContextCount: 1,
        knownContextCount: 2,
        unverifiedContextCount: 1,
        omittedContextCount: 0,
        unverifiedContexts: [{
          context: expect.objectContaining({
            profile: { status: 'verified', value: VULKAN_PROFILE },
            platform: {
              status: 'unverified',
              reason: 'compiler-profile-not-completed',
            },
            graphicsApi: {
              status: 'unverified',
              reason: 'compiler-profile-not-completed',
            },
          }),
          reason: 'compiler-shader-message-source-unavailable',
        }],
      },
    });
    expect(harness.sends.at(-1)?.diagnostics[0].relatedInformation?.at(-1)?.message)
      .toContain('Unverified');
  });

  it('exposes running and completed lifecycle facts for the selected profile', async () => {
    const pending = deferred<readonly AdapterDiagnostic[]>();
    const source = { getShaderMessages: vi.fn(() => pending.promise) };
    const harness = scenario(source, { staticDiagnostics: [] });
    harness.open();
    harness.save();
    const document = harness.documents.snapshot(URI);
    if (!document) throw new Error('expected an open document snapshot');

    expect(harness.adapter.profileStatusesFor(document)).toEqual([{
      status: 'running',
      profile: D3D_PROFILE,
    }]);

    await flush();
    pending.resolve([]);
    await flush(40);

    expect(harness.adapter.profileStatusesFor(document)).toEqual([{
      status: 'completed',
      profile: D3D_PROFILE,
      durationMs: 0,
      success: true,
      warningCount: 0,
      errorCount: 0,
      diagnostics: [],
    }]);
  });

  it('keeps an unsupported selection explicitly unverified', async () => {
    const source = { getShaderMessages: vi.fn(async () => []) };
    const harness = scenario(source, {
      profiles: [D3D_PROFILE],
      selectedProfile: VULKAN_PROFILE,
    });
    harness.open();
    harness.save();
    await flush(40);
    const document = harness.documents.snapshot(URI);
    if (!document) throw new Error('expected an open document snapshot');

    expect(source.getShaderMessages).not.toHaveBeenCalled();
    expect(harness.adapter.profileStatusesFor(document)).toEqual([{
      status: 'profile-not-supported',
      requestedProfile: VULKAN_PROFILE,
      availableProfiles: [D3D_PROFILE],
    }]);
    expect(harness.sends).toEqual([]);
  });

  it('marks every requested profile unverified when the Adapter disconnects', async () => {
    const source = { getShaderMessages: vi.fn(async () => []) };
    const harness = scenario(source, {
      staticDiagnostics: [],
      profiles: [D3D_PROFILE, VULKAN_PROFILE],
    });
    harness.open();
    harness.save();
    await flush();
    harness.adapter.selectProfile(VULKAN_PROFILE);
    await flush(40);
    const document = harness.documents.snapshot(URI);
    if (!document) throw new Error('expected an open document snapshot');

    harness.registry.disconnect();
    await flush();

    expect(harness.adapter.profileStatusesFor(document)).toEqual([
      {
        status: 'adapter-unavailable',
        requestedProfile: D3D_PROFILE,
        reason: 'disconnected',
      },
      {
        status: 'adapter-unavailable',
        requestedProfile: VULKAN_PROFILE,
        reason: 'disconnected',
      },
    ]);
  });

  it('clears fixed compiler messages without clearing static diagnostics', async () => {
    const fixedSource = SOURCE.replace('missing', 'return 0;');
    const source = {
      getShaderMessages: vi.fn()
        .mockResolvedValueOnce([compilerDiagnostic()])
        .mockResolvedValueOnce([]),
    };
    const harness = scenario(source);
    harness.open();
    harness.save();
    await flush();
    expect(harness.sends.at(-1)?.diagnostics).toHaveLength(2);

    harness.change({
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: fixedSource }],
    });
    harness.save();
    await flush(40);

    expect(source.getShaderMessages).toHaveBeenCalledTimes(2);
    expect(harness.sends.at(-1)).toEqual({
      uri: URI,
      version: 2,
      diagnostics: [STATIC_DIAGNOSTIC],
    });
  });

  it('maps Unity warnings and errors to their LSP severities and lines', async () => {
    const source = {
      getShaderMessages: vi.fn(async () => [
        compilerDiagnostic({ severity: 'warning', line: 2, message: 'warning' }),
        compilerDiagnostic({ severity: 'error', line: 4, message: 'error' }),
      ]),
    };
    const harness = scenario(source, { staticDiagnostics: [] });
    harness.open();
    harness.save();
    await flush();

    expect(harness.sends.at(-1)?.diagnostics.map((diagnostic) => ({
      line: diagnostic.range.start.line,
      severity: diagnostic.severity,
    }))).toEqual([
      { line: 1, severity: DiagnosticSeverity.Warning },
      { line: 3, severity: DiagnosticSeverity.Error },
    ]);
  });

  it('clears on disconnect and refreshes the saved asset after reconnect', async () => {
    let instanceId = 'instance-a';
    const source = {
      getShaderMessages: vi.fn(async () => [compilerDiagnostic({ instanceId })]),
    };
    const harness = scenario(source, { connectedBeforeRegistration: false });
    harness.open();

    harness.connect(instanceId);
    await flush();
    expect(harness.sends.at(-1)?.diagnostics).toHaveLength(2);

    harness.registry.disconnect();
    await flush();
    expect(harness.sends.at(-1)?.diagnostics).toEqual([STATIC_DIAGNOSTIC]);

    instanceId = 'instance-b';
    harness.connect(instanceId);
    await flush();

    expect(source.getShaderMessages).toHaveBeenCalledTimes(2);
    expect(harness.sends.at(-1)?.diagnostics.at(-1)?.data).toMatchObject({
      provenance: { instanceId: 'instance-b' },
    });
  });

  it('rejects a result whose source hash predates the saved document', async () => {
    const fixedSource = SOURCE.replace('missing', 'fixed');
    const stale = compilerDiagnostic();
    const source = {
      getShaderMessages: vi.fn()
        .mockResolvedValueOnce([compilerDiagnostic()])
        .mockResolvedValueOnce([stale]),
    };
    const harness = scenario(source);
    harness.open();
    harness.save();
    await flush();

    harness.change({
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: fixedSource }],
    });
    harness.save();
    await flush(40);

    expect(source.getShaderMessages).toHaveBeenCalledTimes(2);
    expect(harness.sends.at(-1)).toEqual({
      uri: URI,
      version: 2,
      diagnostics: [STATIC_DIAGNOSTIC],
    });
  });

  it('never lets an older saved document attempt overwrite the latest result', async () => {
    const newSource = SOURCE.replace('missing', 'newValue');
    const first = deferred<readonly AdapterDiagnostic[]>();
    const second = deferred<readonly AdapterDiagnostic[]>();
    const source = {
      getShaderMessages: vi.fn((
        _documentUri: string,
        _profile: CompileProfile,
        _cancellation?: AbortSignal,
      ) => Promise.resolve<readonly AdapterDiagnostic[]>([]))
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    };
    const harness = scenario(source);
    harness.open();
    harness.save();
    await flush();

    harness.change({
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: newSource }],
    });
    harness.save();
    await flush();
    expect(source.getShaderMessages.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(source.getShaderMessages.mock.calls[1]?.[2]?.aborted).toBe(false);
    second.resolve([compilerDiagnostic({
      source: newSource,
      message: 'new result',
    })]);
    await flush(40);
    expect(harness.sends.at(-1)).toMatchObject({
      version: 2,
      diagnostics: [
        STATIC_DIAGNOSTIC,
        { message: 'new result\nat fragment program' },
      ],
    });
    const sendCount = harness.sends.length;

    first.resolve([compilerDiagnostic({ message: 'old result' })]);
    await flush(40);

    expect(harness.sends).toHaveLength(sendCount);
    expect(harness.sends.at(-1)?.diagnostics.at(-1)?.message).toBe(
      'new result\nat fragment program',
    );
  });

  it('rejects compiler evidence attributed to a foreign Unity project', async () => {
    const source = {
      getShaderMessages: vi.fn(async () => [compilerDiagnostic({
        projectId: 'project-b',
      })]),
    };
    const harness = scenario(source);
    harness.open();
    harness.save();
    await flush();

    expect(source.getShaderMessages).toHaveBeenCalledOnce();
    expect(harness.sends).toEqual([]);
  });

  it('drops an in-flight result after the Adapter disconnects', async () => {
    const pending = deferred<readonly AdapterDiagnostic[]>();
    const source = { getShaderMessages: vi.fn(() => pending.promise) };
    const harness = scenario(source);
    harness.open();
    harness.save();
    await flush();
    expect(source.getShaderMessages).toHaveBeenCalledOnce();

    harness.registry.disconnect();
    pending.resolve([compilerDiagnostic()]);
    await flush(40);

    expect(harness.sends).toEqual([]);
  });

  it('clears all diagnostics when the current asset closes', async () => {
    const source = { getShaderMessages: vi.fn(async () => [compilerDiagnostic()]) };
    const harness = scenario(source);
    harness.open();
    harness.save();
    await flush();

    harness.close({ textDocument: { uri: URI } });
    await flush(40);

    expect(harness.sends.at(-1)).toEqual({ uri: URI, diagnostics: [] });
  });

  it('clears compiler diagnostics and saved refresh state when the asset is deleted', async () => {
    const source = { getShaderMessages: vi.fn(async () => [compilerDiagnostic()]) };
    const harness = scenario(source);
    harness.open();
    harness.save();
    await flush();
    expect(harness.sends.at(-1)?.diagnostics).toHaveLength(2);

    harness.adapter.handleFileEvent({ uri: URI, type: 'deleted' });
    await flush(40);

    expect(harness.sends.at(-1)).toEqual({
      uri: URI,
      version: 1,
      diagnostics: [STATIC_DIAGNOSTIC],
    });
    harness.registry.disconnect();
    harness.connect('instance-b');
    await flush();
    expect(source.getShaderMessages).toHaveBeenCalledOnce();
  });
});
