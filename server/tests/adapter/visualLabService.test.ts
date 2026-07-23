import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_VISUAL_LAB_IMAGE_DIMENSION,
  MAX_VISUAL_LAB_PNG_BYTES,
  MATERIAL_CONTEXT_ADAPTER_FEATURE,
  VISUAL_LAB_ADAPTER_FEATURE,
  type IncludePointContext,
  type SelectedMaterialContext,
  type VisualLabDescribeTargetRequest,
  type VisualLabFrameEvidence,
  type VisualLabRenderRequest,
  type VisualLabRenderTarget,
  type VisualLabSelectionIdentity,
} from '@unity-shader-nav/shared';
import { VisualLabService } from '../../src/adapter/visualLabService';
import {
  createVisualLabSelectionIdentity,
  validateVisualLabFrameEvidence,
  validateVisualLabTargetDescription,
  validVisualLabRenderTarget,
  validVisualLabSelectionIdentity,
  type VisualLabSource,
  type VisualLabSourceInvalidationReason,
} from '../../src/adapter/visualLabSource';

const NOW = 10_000;
const DOCUMENT_URI = 'file:///project/Assets/VisualLab/Capture.shader';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function selection(
  sourceHash = HASH_B,
  selectionId = 'selection-a',
): VisualLabSelectionIdentity {
  return {
    selectionId,
    contextRevision: `context-${sourceHash.slice(0, 4)}`,
    material: {
      name: 'Capture Material',
      path: 'Assets/VisualLab/Capture.mat',
      revision: {
        uri: 'file:///project/Assets/VisualLab/Capture.mat',
        assetGuid: 'material-guid',
        contentHash: HASH_A,
      },
    },
    source: {
      name: 'Capture Shader',
      path: 'Assets/VisualLab/Capture.shader',
      revision: {
        uri: 'file:///project/Assets/VisualLab/Capture.shader',
        assetGuid: 'shader-guid',
        contentHash: sourceHash,
      },
    },
    requestedContext: {
      contextId: 'context-frag',
      shaderUri: 'file:///project/Assets/VisualLab/Capture.shader',
      subShaderIndex: 0,
      passIndex: 0,
      passName: 'Forward',
      stage: 'fragment',
      entryPoint: 'frag',
    },
    materialKeywords: [{
      name: 'CAPTURE_TINT',
      enabled: true,
      scope: 'local',
    }],
    adapter: {
      projectId: 'project-a',
      instanceId: 'editor-a',
      adapterVersion: '0.1.0',
      unityVersion: '2022.3.62f1',
    },
  };
}

function target(
  selected: VisualLabSelectionIdentity,
  overrides: Partial<VisualLabRenderTarget> = {},
): VisualLabRenderTarget {
  return {
    selectionId: selected.selectionId,
    contextRevision: selected.contextRevision,
    material: selected.material,
    source: selected.source,
    shaderContext: {
      contextId: selected.requestedContext.contextId,
      shaderName: 'Hidden/UnityShaderNav/VisualLabCapture',
      subShaderIndex: selected.requestedContext.subShaderIndex,
      passIndex: selected.requestedContext.passIndex ?? 0,
      passName: selected.requestedContext.passName,
      stage: selected.requestedContext.stage,
      entryPoint: selected.requestedContext.entryPoint,
      keywords: {
        material: ['CAPTURE_TINT'],
        global: ['STEREO_INSTANCING_ON'],
        engineAdded: ['UNITY_COLORSPACE_GAMMA'],
      },
    },
    pipeline: {
      id: 'built-in',
      kind: 'built-in',
      name: 'Built-in Render Pipeline',
    },
    profile: {
      id: 'macos-metal-quality-0',
      buildTarget: 'StandaloneOSX',
      graphicsApi: 'Metal',
      qualityLevel: 0,
      renderTarget: {
        width: 2,
        height: 2,
        format: 'R8G8B8A8_UNorm',
      },
    },
    colorSpace: 'linear',
    adapter: selected.adapter,
    renderInputId: 'visual-lab-input/v1',
    ...overrides,
  };
}

function frame(request: VisualLabRenderRequest): VisualLabFrameEvidence {
  const { width, height } = request.target.profile.renderTarget;
  const png = minimalPng(width, height);
  const mask = Buffer.from(
    Array.from({ length: width * height }, (_value, index) => (
      index === 1 || index === 3 ? 255 : 0
    )),
  );
  const masked = [...mask].filter((value) => value === 255).length;
  return {
    capability: VISUAL_LAB_ADAPTER_FEATURE,
    slot: request.slot,
    requestGeneration: request.requestGeneration,
    target: request.target,
    capturedAt: NOW - 1,
    image: {
      mediaType: 'image/png',
      encoding: 'base64',
      width,
      height,
      byteLength: png.length,
      sha256: sha256(png),
      data: png.toString('base64'),
    },
    diagnostic: {
      nanInfMask: {
        format: 'r8',
        origin: 'top-left',
        layout: 'row-major',
        encoding: 'base64',
        width,
        height,
        byteLength: mask.length,
        data: mask.toString('base64'),
        nanPixelCount: Math.min(1, masked),
        infinitePixelCount: Math.max(0, masked - 1),
        maskedPixelCount: masked,
      },
    },
  };
}

function harness() {
  let currentSelection = selection();
  let invalidationListener:
    | ((reason: VisualLabSourceInvalidationReason) => void)
    | undefined;
  let describeTarget = (request: VisualLabDescribeTargetRequest) => (
    target(request.selection)
  );
  const source: VisualLabSource = {
    describePreviewTarget: vi.fn(async (request) => ({
      capability: VISUAL_LAB_ADAPTER_FEATURE,
      target: describeTarget(request),
    })),
    renderPreview: vi.fn(async (request) => frame(request)),
    onDidInvalidate: (listener) => {
      invalidationListener = listener;
      return { dispose: () => { invalidationListener = undefined; } };
    },
  };
  const selectionProvider = {
    selectedVisualLabMaterial: vi.fn(async () => ({
      availability: 'available' as const,
      selection: currentSelection,
    })),
  };
  const service = new VisualLabService({
    source,
    selectionProvider,
    now: () => NOW,
  });
  return {
    service,
    source,
    selectionProvider,
    setSelection(value: VisualLabSelectionIdentity) {
      currentSelection = value;
    },
    setDescribeTarget(
      value: (request: VisualLabDescribeTargetRequest) => VisualLabRenderTarget,
    ) {
      describeTarget = value;
    },
    invalidateFromAdapter(reason: VisualLabSourceInvalidationReason) {
      invalidationListener?.(reason);
    },
  };
}

describe('VisualLabSource evidence boundary', () => {
  it('builds describe identity only from matching Material and explicit source Context evidence', () => {
    const selected = selection();
    const materialContext: SelectedMaterialContext = {
      selectionId: selected.selectionId,
      material: selected.material,
      shader: selected.source,
      properties: [],
      textures: [],
      keywords: {
        material: selected.materialKeywords,
        global: { status: 'unknown', reason: 'draw-evidence-required' },
        engineAdded: { status: 'unknown', reason: 'draw-evidence-required' },
      },
      provenance: {
        capability: MATERIAL_CONTEXT_ADAPTER_FEATURE,
        projectId: selected.adapter.projectId,
        instanceId: selected.adapter.instanceId,
        adapterVersion: selected.adapter.adapterVersion,
        unityVersion: selected.adapter.unityVersion,
        collectedAt: NOW - 2,
        sourceRevision: selected.contextRevision,
      },
    };
    const requested: IncludePointContext = {
      id: selected.requestedContext.contextId,
      shaderName: 'Capture Shader',
      shaderUri: selected.requestedContext.shaderUri,
      subShaderIndex: selected.requestedContext.subShaderIndex,
      passIndex: selected.requestedContext.passIndex,
      passName: selected.requestedContext.passName,
      stage: selected.requestedContext.stage,
      entryPoint: selected.requestedContext.entryPoint,
      includeLocation: {
        uri: selected.requestedContext.shaderUri,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 10 },
        },
      },
      chainDepth: 0,
    };

    expect(createVisualLabSelectionIdentity(
      materialContext,
      requested,
      selected.contextRevision,
    )).toEqual(selected);
    expect(createVisualLabSelectionIdentity(materialContext, {
      ...requested,
      shaderUri: 'file:///project/Assets/Other.shader',
    }, selected.contextRevision)).toBeUndefined();
    expect(createVisualLabSelectionIdentity(
      materialContext,
      requested,
      '',
    )).toBeUndefined();
  });

  it('accepts an explicit source Context without inventing an optional selected Pass', () => {
    const selected = selection();

    expect(validVisualLabSelectionIdentity(selected)).toBe(true);
    expect(validateVisualLabTargetDescription({
      capability: VISUAL_LAB_ADAPTER_FEATURE,
      target: target(selected),
    }, { selection: selected })).toBeUndefined();
  });

  it('rejects a target that does not repeat Material Context and source Context identity', () => {
    const selected = selection();
    const changed = target(selected, {
      adapter: { ...selected.adapter, instanceId: 'editor-reloaded' },
    });

    expect(validateVisualLabTargetDescription({
      capability: VISUAL_LAB_ADAPTER_FEATURE,
      target: changed,
    }, { selection: selected })).toBe('identity-mismatch');
  });

  it('rejects non-binary masks and exact-count disagreements independently of PNG pixels', () => {
    const request: VisualLabRenderRequest = {
      slot: 'before',
      requestGeneration: 1,
      target: target(selection()),
    };
    const evidence = frame(request);
    const nonBinary = {
      ...evidence,
      diagnostic: {
        nanInfMask: {
          ...evidence.diagnostic.nanInfMask,
          data: Buffer.from([0, 127, 0, 255]).toString('base64'),
        },
      },
    };
    const wrongCount = {
      ...evidence,
      diagnostic: {
        nanInfMask: {
          ...evidence.diagnostic.nanInfMask,
          nanPixelCount: 0,
          infinitePixelCount: 1,
          maskedPixelCount: 1,
        },
      },
    };

    expect(validateVisualLabFrameEvidence(
      nonBinary,
      request,
      NOW,
    )).toBe('invalid-evidence');
    expect(validateVisualLabFrameEvidence(
      wrongCount,
      request,
      NOW,
    )).toBe('invalid-evidence');
  });

  it('enforces PNG byte and render-target dimension bounds', () => {
    const request: VisualLabRenderRequest = {
      slot: 'after',
      requestGeneration: 2,
      target: target(selection()),
    };
    const oversizedImage = {
      ...frame(request),
      image: {
        ...frame(request).image,
        byteLength: MAX_VISUAL_LAB_PNG_BYTES + 1,
        data: '',
      },
    };
    const oversizedTarget = target(selection(), {
      profile: {
        ...target(selection()).profile,
        renderTarget: {
          ...target(selection()).profile.renderTarget,
          width: MAX_VISUAL_LAB_IMAGE_DIMENSION + 1,
        },
      },
    });

    expect(validateVisualLabFrameEvidence(
      oversizedImage,
      request,
      NOW,
    )).toBe('evidence-limit-exceeded');
    expect(validVisualLabRenderTarget(oversizedTarget)).toBe(false);
  });
});

describe('VisualLabService', () => {
  it('keeps state pulls read-only until the explicit pin action', async () => {
    const test = harness();

    expect(test.service.state()).toMatchObject({
      status: 'unavailable',
      reason: 'no-selection',
    });
    test.service.state();
    test.service.state();

    expect(test.selectionProvider.selectedVisualLabMaterial).not.toHaveBeenCalled();
    expect(test.source.describePreviewTarget).not.toHaveBeenCalled();

    const selected = await test.service.selectCurrentTarget(DOCUMENT_URI);
    expect(selected).toMatchObject({
      status: 'available',
      target: { material: { name: 'Capture Material' } },
    });
    expect(
      test.selectionProvider.selectedVisualLabMaterial,
    ).toHaveBeenCalledWith(DOCUMENT_URI);
    expect(test.source.describePreviewTarget).toHaveBeenCalledOnce();
  });

  it('marks a selection change stale without silently pinning the new Material', async () => {
    const test = harness();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    await test.service.capture('before');
    const original = test.service.state();
    const describeCalls = vi.mocked(test.source.describePreviewTarget).mock.calls.length;
    test.setSelection(selection(HASH_C, 'selection-b'));

    test.service.markSelectionChanged();
    const stale = test.service.state();
    test.service.state();

    expect(stale).toMatchObject({
      status: 'unavailable',
      reason: 'invalid-target',
      pinnedTarget: { selectionId: 'selection-a' },
      before: {
        status: 'stale',
        reason: 'selection-changed',
        frame: { target: { selectionId: 'selection-a' } },
      },
    });
    expect(original.status).toBe('available');
    expect(vi.mocked(test.source.describePreviewTarget).mock.calls).toHaveLength(
      describeCalls,
    );

    const repinned = await test.service.selectCurrentTarget(DOCUMENT_URI);
    expect(repinned).toMatchObject({
      status: 'available',
      target: { selectionId: 'selection-b' },
      before: { status: 'stale' },
    });
  });

  it('retains independently proven Before and After frames across a source edit', async () => {
    const test = harness();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    await test.service.capture('before');

    test.setSelection(selection(HASH_C));
    test.service.markSourceChanged();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    await test.service.capture('after');

    const state = test.service.state();
    expect(state).toMatchObject({
      status: 'available',
      before: {
        status: 'stale',
        frame: {
          slot: 'before',
          target: { source: { revision: { contentHash: HASH_B } } },
        },
      },
      after: {
        status: 'current',
        frame: {
          slot: 'after',
          target: { source: { revision: { contentHash: HASH_C } } },
        },
      },
    });
  });

  it('drops a late same-slot frame after a newer request generation completes', async () => {
    const test = harness();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    const pending = deferred<unknown>();
    vi.mocked(test.source.renderPreview)
      .mockImplementationOnce(async () => pending.promise)
      .mockImplementationOnce(async (request) => frame(request));

    const firstCapture = test.service.capture('before');
    await vi.waitFor(() => {
      expect(test.source.renderPreview).toHaveBeenCalledTimes(1);
    });
    const firstRequest = vi.mocked(test.source.renderPreview).mock.calls[0]![0];
    await test.service.capture('before');
    pending.resolve(frame(firstRequest));
    await firstCapture;

    const state = test.service.state();
    expect(state.status).toBe('available');
    expect(state.before).toMatchObject({
      status: 'current',
      frame: { requestGeneration: 2 },
    });
  });

  it('rejects Adapter target drift before rendering instead of auto-repinning', async () => {
    const test = harness();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    test.setDescribeTarget((request) => target(request.selection, {
      profile: {
        ...target(request.selection).profile,
        id: 'changed-profile',
      },
    }));

    await test.service.capture('after');

    expect(test.source.renderPreview).not.toHaveBeenCalled();
    expect(test.service.state()).toMatchObject({
      status: 'unavailable',
      reason: 'invalid-target',
      pinnedTarget: { profile: { id: 'macos-metal-quality-0' } },
    });
  });

  it('stales retained output when capture revalidation observes a disconnected provider', async () => {
    const test = harness();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    await test.service.capture('before');
    vi.mocked(test.selectionProvider.selectedVisualLabMaterial)
      .mockResolvedValueOnce({
        availability: 'unavailable',
        reason: 'adapter-disconnected',
      });

    await test.service.capture('after');

    expect(test.source.renderPreview).toHaveBeenCalledTimes(1);
    expect(test.service.state()).toMatchObject({
      status: 'unavailable',
      reason: 'adapter-disconnected',
      before: {
        status: 'stale',
        reason: 'adapter-disconnected',
      },
    });
  });

  it.each<VisualLabSourceInvalidationReason>([
    'pipeline-changed',
    'profile-changed',
    'color-space-changed',
    'render-input-changed',
    'adapter-instance-changed',
  ])('immediately marks frames stale on Adapter %s events', async (reason) => {
    const test = harness();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    await test.service.capture('before');

    test.invalidateFromAdapter(reason);

    expect(test.service.state()).toMatchObject({
      status: 'unavailable',
      reason: 'invalid-target',
      before: { status: 'stale', reason },
    });
  });

  it('rejects a late frame after domain reload and keeps old output explicitly stale', async () => {
    const test = harness();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    await test.service.capture('before');
    const pending = deferred<unknown>();
    vi.mocked(test.source.renderPreview).mockImplementationOnce(
      async () => pending.promise,
    );

    const afterCapture = test.service.capture('after');
    await vi.waitFor(() => {
      expect(test.source.renderPreview).toHaveBeenCalledTimes(2);
    });
    const request = vi.mocked(test.source.renderPreview).mock.calls[1]![0];
    test.invalidateFromAdapter('domain-reloaded');
    pending.resolve(frame(request));
    await afterCapture;

    expect(test.service.state()).toMatchObject({
      status: 'unavailable',
      reason: 'adapter-disconnected',
      before: {
        status: 'stale',
        reason: 'domain-reloaded',
      },
      after: { status: 'empty' },
    });
  });

  it('rejects a response for the wrong request generation', async () => {
    const test = harness();
    await test.service.selectCurrentTarget(DOCUMENT_URI);
    vi.mocked(test.source.renderPreview).mockImplementationOnce(
      async (request) => ({
        ...frame(request),
        requestGeneration: request.requestGeneration + 1,
      }),
    );

    await test.service.capture('after');

    expect(test.service.state()).toMatchObject({
      status: 'available',
      after: {
        status: 'failed',
        reason: 'identity-mismatch',
      },
    });
  });
});

function minimalPng(width: number, height: number): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const idat = Buffer.alloc(12);
  idat.write('IDAT', 4, 'ascii');
  const iend = Buffer.from([
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
