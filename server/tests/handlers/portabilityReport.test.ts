import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import {
  PORTABILITY_REPORT_REQUEST,
  PORTABILITY_TARGETS_REQUEST,
  type CompileProfile,
  type PortabilityReport,
  type PortabilityReportParams,
  type PortabilityTargetsParams,
  type PortabilityTargetsResult,
} from '@unity-shader-nav/shared';
import { registerPortabilityReportHandler } from '../../src/handlers/portabilityReport';
import { portabilityTargetStore } from '../../src/portability/targetStore';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';

const URI = 'file:///project/Assets/Unlit.shader';
const DOCUMENT: IndexedDocumentSnapshot = {
  uri: URI,
  languageId: 'shaderlab',
  text: 'Shader "Unlit" {}',
  openId: 1,
  version: 4,
};
const PROFILE: CompileProfile = {
  name: 'Windows Vulkan',
  platform: 'StandaloneWindows64',
  graphicsApi: 'Vulkan',
  capability: 'shader-messages',
};
const PIPELINE_REPORT: PortabilityReport = {
  uri: URI,
  target: { kind: 'render-pipeline', pipeline: 'universal' },
  environment: {
    unityVersion: '2022.3.62f1',
    renderPipelinePackage: {
      name: 'com.unity.render-pipelines.universal',
      version: '14.0.11',
      source: 'registry',
      official: true,
    },
  },
  equivalence: 'not-claimed',
  compilerVerification: { status: 'required' },
  findings: [],
};

type TargetsHandler = (params: PortabilityTargetsParams) => Promise<PortabilityTargetsResult>;
type ReportHandler = (params: PortabilityReportParams) => Promise<PortabilityReport | null>;

function connectionHarness(): {
  connection: Connection;
  targets(): TargetsHandler;
  report(): ReportHandler;
} {
  const handlers = new Map<string, unknown>();
  return {
    connection: {
      onRequest(method: string, handler: unknown) {
        handlers.set(method, handler);
        return { dispose() {} };
      },
    } as unknown as Connection,
    targets() {
      const handler = handlers.get(PORTABILITY_TARGETS_REQUEST);
      if (!handler) throw new Error('targets handler not registered');
      return handler as TargetsHandler;
    },
    report() {
      const handler = handlers.get(PORTABILITY_REPORT_REQUEST);
      if (!handler) throw new Error('report handler not registered');
      return handler as ReportHandler;
    },
  };
}

describe('registerPortabilityReportHandler', () => {
  it('combines revision versions with Adapter profiles and verifies the selected profile', async () => {
    portabilityTargetStore.clear();
    const harness = connectionHarness();
    const completed = {
      status: 'completed',
      profile: PROFILE,
      durationMs: 7,
      success: true,
      warningCount: 0,
      errorCount: 0,
      diagnostics: [],
    } as const;
    const profileReport: PortabilityReport = {
      ...PIPELINE_REPORT,
      target: { kind: 'graphics-profile', profile: PROFILE },
      compilerVerification: {
        status: 'passed',
        profile: PROFILE,
        unityVersion: '2022.3.62f1',
        durationMs: 7,
        warningCount: 0,
        errorCount: 0,
      },
    };
    const portabilityReportAt = vi.fn(async (input: {
      target: PortabilityReport['target'];
      compilerResult?: typeof completed;
    }) => input.target.kind === 'render-pipeline' ? PIPELINE_REPORT : profileReport);
    const shaderMessagesFor = vi.fn(async () => completed);
    const refresh = vi.fn();

    registerPortabilityReportHandler(
      harness.connection,
      { snapshot: () => DOCUMENT },
      { servingWorkspaceFor: () => ({ portabilityReportAt } as unknown as IndexedWorkspace) },
      {
        compileProfiles: async () => ({ status: 'available', profiles: [PROFILE] }),
        shaderMessagesFor,
      },
      refresh,
    );

    await expect(harness.targets()({ textDocument: { uri: URI } })).resolves.toEqual({
      targets: [
        expect.objectContaining({
          target: { kind: 'render-pipeline', pipeline: 'universal' },
          detail: expect.stringContaining('Unity 2022.3.62f1 · URP 14.0.11'),
        }),
        expect.objectContaining({ target: { kind: 'graphics-profile', profile: PROFILE } }),
      ],
    });
    await expect(harness.report()({
      textDocument: { uri: URI },
      target: { kind: 'graphics-profile', profile: PROFILE },
    })).resolves.toBe(profileReport);

    expect(shaderMessagesFor).toHaveBeenCalledWith(
      URI,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      PROFILE,
    );
    expect(portabilityTargetStore.get(URI)).toEqual({
      kind: 'graphics-profile',
      profile: PROFILE,
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects compiler evidence when the open document changes during the request', async () => {
    portabilityTargetStore.clear();
    const harness = connectionHarness();
    let currentDocument = DOCUMENT;
    const portabilityReportAt = vi.fn(async () => PIPELINE_REPORT);
    const refresh = vi.fn();

    registerPortabilityReportHandler(
      harness.connection,
      { snapshot: () => currentDocument },
      { servingWorkspaceFor: () => ({ portabilityReportAt } as unknown as IndexedWorkspace) },
      {
        compileProfiles: async () => ({ status: 'available', profiles: [PROFILE] }),
        shaderMessagesFor: async () => {
          currentDocument = {
            ...DOCUMENT,
            version: DOCUMENT.version + 1,
            text: `${DOCUMENT.text}\n// changed`,
          };
          return {
            status: 'completed',
            profile: PROFILE,
            durationMs: 7,
            success: true,
            warningCount: 0,
            errorCount: 0,
            diagnostics: [],
          };
        },
      },
      refresh,
    );

    await expect(harness.report()({
      textDocument: { uri: URI },
      target: { kind: 'graphics-profile', profile: PROFILE },
    })).resolves.toBeNull();
    expect(portabilityReportAt).not.toHaveBeenCalled();
    expect(portabilityTargetStore.get(URI)).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});
