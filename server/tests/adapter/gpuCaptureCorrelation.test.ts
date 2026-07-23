import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  GpuCaptureEvidence,
  GpuCaptureReplayEnvironment,
} from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  GpuCaptureCorrelationAdapter,
  correlateGpuCaptureEvidence,
  validateGpuCaptureEvidence,
} from '../../src/adapter/gpuCaptureCorrelation';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'gpu-capture');
const PROTOTYPE_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  'tools',
  'gpu-capture-prototype',
  'UnityProject',
  'Assets',
  'Shaders',
  'CaptureProbe.shader',
);
const SOURCE_URI = 'project://Assets/Shaders/CaptureProbe.shader';
const PROJECT_ID = 'gpu-capture-prototype';
const ENVIRONMENT: GpuCaptureReplayEnvironment = {
  operatingSystem: 'macOS',
  operatingSystemVersion: '26.3 (25D125)',
  architecture: 'arm64',
  graphicsApi: 'Metal',
  gpuName: 'Apple M4 Pro',
  gpuDriverVersion:
    'OS build 25D125; Apple metal version 32023.883 (metalfe-32023.883)',
  toolName: 'Xcode Metal Frame Debugger',
  toolVersion: '26.6',
  toolBuildVersion: '17F113',
  metalCompilerVersion:
    'Apple metal version 32023.883 (metalfe-32023.883)',
  unityVersion: '2022.3.62f1',
  unityBinaryVersion: '2022.3.62f1',
  adapterVersion: 'prototype-1',
};

async function fixture() {
  const sourceText = await readFile(PROTOTYPE_SOURCE, 'utf8');
  const evidence = JSON.parse(
    await readFile(join(FIXTURE_DIR, 'CaptureProbe.evidence.json'), 'utf8'),
  ) as GpuCaptureEvidence;
  return { sourceText, evidence };
}

function correlate(
  sourceText: string,
  evidence: unknown,
  overrides: Partial<Parameters<typeof correlateGpuCaptureEvidence>[0]> = {},
) {
  return correlateGpuCaptureEvidence({
    evidence,
    projectId: PROJECT_ID,
    sourceUri: SOURCE_URI,
    sourceAssetGuid: 'f14aeb7b969724b9797221308d626ee8',
    sourceText,
    replayEnvironment: ENVIRONMENT,
    traceVerification: { status: 'sanitized-fixture' },
    ...overrides,
  });
}

describe('macOS Metal GPU capture correlation prototype', () => {
  it('maps one exact captured draw to Shader Context and source range', async () => {
    const { sourceText, evidence } = await fixture();
    const result = correlate(sourceText, evidence);

    expect(validateGpuCaptureEvidence(evidence)).toBeNull();
    expect(result).toMatchObject({
      status: 'current',
      traceStatus: 'sanitized-fixture',
      uri: SOURCE_URI,
      range: {
        start: { line: 23, character: 19 },
        end: { line: 23, character: 23 },
      },
      context: {
        shaderName: 'UnityShaderNav/CaptureProbe',
        passIndex: 0,
        passName: 'Forward',
        stage: 'fragment',
        entryPoint: 'frag',
        keywords: {
          enabled: ['CAPTURE_TINT'],
          incomplete: true,
        },
      },
      evidence: {
        provenance: {
          platform: {
            operatingSystem: 'macOS',
            architecture: 'arm64',
          },
          gpu: {
            name: 'Apple M4 Pro',
            driverVersion: 'OS build 25D125; Apple metal version 32023.883 (metalfe-32023.883)',
          },
          graphicsApi: 'Metal',
          tool: {
            name: 'Xcode Metal Frame Debugger',
            version: '26.6',
            metalCompilerVersion: 'Apple metal version 32023.883 (metalfe-32023.883)',
          },
          collectedAt: 1784839447000,
        },
        draw: {
          label: 'UnityShaderNav Capture Probe 51e76b895fd6 capture-probe-forward-fragment',
          trace: {
            storage: 'local-ephemeral',
            fileName: 'CaptureProbe.gputrace',
          },
        },
      },
    });
  });

  it('marks changed source stale and never returns a current location', async () => {
    const { sourceText, evidence } = await fixture();
    const result = correlate(`${sourceText}\n// source drift`, evidence);

    expect(result).toMatchObject({
      status: 'stale',
      reason: 'source-hash-mismatch',
    });
    expect(result).not.toHaveProperty('range');
  });

  it('marks a recreated Unity asset stale even when URI and source bytes match', async () => {
    const { sourceText, evidence } = await fixture();
    expect(correlate(sourceText, evidence, {
      sourceAssetGuid: 'recreated-asset-guid',
    })).toMatchObject({
      status: 'stale',
      reason: 'asset-guid-mismatch',
    });
  });

  it('rejects incompatible project and any unverified replay environment drift', async () => {
    const { sourceText, evidence } = await fixture();
    expect(correlate(sourceText, evidence, {
      projectId: 'another-project',
    })).toMatchObject({
      status: 'unavailable',
      reason: 'project-mismatch',
    });
    for (const replayEnvironment of [
      { ...ENVIRONMENT, operatingSystemVersion: '26.4 (another-build)' },
      { ...ENVIRONMENT, gpuName: 'Another Apple GPU' },
      { ...ENVIRONMENT, gpuDriverVersion: 'another-driver' },
      { ...ENVIRONMENT, toolVersion: '26.7' },
      { ...ENVIRONMENT, toolBuildVersion: 'another-xcode-build' },
      { ...ENVIRONMENT, metalCompilerVersion: 'another-metal-toolchain' },
      { ...ENVIRONMENT, unityVersion: '2022.3.63f1' },
      { ...ENVIRONMENT, unityBinaryVersion: '2022.3.62f1.custom-build' },
      { ...ENVIRONMENT, adapterVersion: 'prototype-2' },
    ]) {
      expect(correlate(sourceText, evidence, {
        replayEnvironment,
      })).toMatchObject({
        status: 'unavailable',
        reason: 'replay-environment-mismatch',
      });
    }
  });

  it('keeps mapped-range and tool mapping failures explicit', async () => {
    const { sourceText, evidence } = await fixture();
    expect(correlate(sourceText, {
      ...evidence,
      mapping: {
        ...evidence.mapping,
        range: {
          start: { line: 23, character: 20 },
          end: { line: 23, character: 24 },
        },
      },
    })).toMatchObject({
      status: 'unmapped',
      reason: 'mapped-text-mismatch',
    });
    expect(correlate(sourceText, {
      ...evidence,
      mapping: {
        status: 'unmapped',
        reason: 'generated-source-has-no-line-map',
        detail: 'Xcode generated text had no exact HLSL line map.',
      },
    })).toMatchObject({
      status: 'unmapped',
      reason: 'generated-source-has-no-line-map',
    });
  });

  it('requires a real local trace to match hash, size, filename, and draw label', async () => {
    const { sourceText, evidence } = await fixture();
    const verified = {
      status: 'verified-local-trace' as const,
      fileName: evidence.draw.trace.fileName,
      sha256: evidence.draw.trace.sha256,
      byteLength: evidence.draw.trace.byteLength,
      labels: [evidence.draw.label],
    };
    expect(correlate(sourceText, evidence, {
      traceVerification: verified,
    })).toMatchObject({
      status: 'current',
      traceStatus: 'verified-local-trace',
    });
    expect(correlate(sourceText, evidence, {
      traceVerification: { ...verified, sha256: 'b'.repeat(64) },
    })).toMatchObject({
      status: 'unavailable',
      reason: 'trace-identity-mismatch',
    });
    expect(correlate(sourceText, evidence, {
      traceVerification: { ...verified, labels: [] },
    })).toMatchObject({
      status: 'unavailable',
      reason: 'trace-label-missing',
    });
  });

  it('rejects unbounded or repository-unsafe trace evidence', async () => {
    const { evidence } = await fixture();
    expect(validateGpuCaptureEvidence({
      ...evidence,
      draw: {
        ...evidence.draw,
        trace: {
          ...evidence.draw.trace,
          fileName: '/private/tmp/CaptureProbe.gputrace',
        },
      },
    })).toBe('captured draw identity is invalid');
    expect(validateGpuCaptureEvidence({
      ...evidence,
      context: {
        ...evidence.context,
        keywords: {
          enabled: Array.from({ length: 257 }, (_, index) => `K${index}`),
          incomplete: false,
        },
      },
    })).toBe('captured Shader Context is invalid');
  });

  it('uses one bounded source Adapter and checks requested capture identity', async () => {
    const { sourceText, evidence } = await fixture();
    const getGpuCaptureEvidence = vi.fn(async () => evidence);
    const adapter = new GpuCaptureCorrelationAdapter({ getGpuCaptureEvidence });

    await expect(adapter.correlate({
      captureId: evidence.draw.captureId,
      projectId: PROJECT_ID,
      sourceUri: SOURCE_URI,
      sourceAssetGuid: evidence.provenance.sourceRevision.assetGuid,
      sourceText,
      replayEnvironment: ENVIRONMENT,
      traceVerification: { status: 'sanitized-fixture' },
    })).resolves.toMatchObject({ status: 'current' });
    expect(getGpuCaptureEvidence).toHaveBeenCalledWith(evidence.draw.captureId);

    await expect(adapter.correlate({
      captureId: 'another-capture',
      projectId: PROJECT_ID,
      sourceUri: SOURCE_URI,
      sourceAssetGuid: evidence.provenance.sourceRevision.assetGuid,
      sourceText,
      replayEnvironment: ENVIRONMENT,
      traceVerification: { status: 'sanitized-fixture' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'invalid-evidence',
      detail: 'capture identity does not match the requested capture',
    });
  });
});
