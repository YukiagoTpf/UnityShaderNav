import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  MAX_VISUAL_LAB_PNG_BYTES,
  VISUAL_LAB_ADAPTER_FEATURE,
  type VisualLabFrameEvidence,
  type VisualLabRenderTarget,
  type VisualLabSessionState,
} from '@unity-shader-nav/shared';

interface PresentationModule {
  readonly VisualLabClientSession: new () => {
    snapshot(): {
      readonly session?: VisualLabSessionState;
      readonly message?: string;
    };
    beginCapture(slot: 'before' | 'after'): number | undefined;
    settle(
      generation: number,
      state: VisualLabSessionState,
      expected: 'read-state' | 'use-current' | 'capture',
      slot?: 'before' | 'after',
    ): boolean;
    applyServerState(state: VisualLabSessionState): void;
    invalidate(reason: 'source-revision-changed'): void;
  };
  renderVisualLabHtml(
    snapshot: {
      readonly connection: 'connected' | 'disconnected';
      readonly session?: VisualLabSessionState;
    },
    options: { readonly cspSource: string; readonly nonce: string },
  ): string;
  validatedPngDataUri(frame: VisualLabFrameEvidence['image']): string;
  validatedNanInfMask(
    mask: VisualLabFrameEvidence['diagnostic']['nanInfMask'],
  ): string;
}

const presentation = require(path.resolve(
  __dirname,
  '../../../client/out/visualLabPresentation.js',
)) as PresentationModule;

const PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_SHA256 =
  '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';

suite('Visual Lab client presentation', () => {
  test('invalidates retained frames immediately and discards a late capture generation', () => {
    const session = new presentation.VisualLabClientSession();
    const initial = sessionState(frame('before', target()));
    session.applyServerState(initial);

    const generation = session.beginCapture('after');
    assert.strictEqual(typeof generation, 'number');
    session.invalidate('source-revision-changed');

    const late = sessionState(
      frame('before', target()),
      frame('after', target({ sourceHash: 'b'.repeat(64) })),
    );
    assert.strictEqual(
      session.settle(generation!, late, 'capture', 'after'),
      false,
    );
    const snapshot = session.snapshot();
    assert.strictEqual(snapshot.session?.status, 'unavailable');
    assert.strictEqual(
      snapshot.session?.status === 'unavailable'
        ? snapshot.session.reason
        : undefined,
      'invalid-target',
    );
    assert.strictEqual(snapshot.session?.before.status, 'stale');
    assert.strictEqual(snapshot.session?.after.status, 'empty');
    assert.match(snapshot.message ?? '', /source revision changed/);
  });

  test('renders independent Before and After provenance with an explicit identity delta', () => {
    const before = frame('before', target());
    const after = frame('after', target({
      sourceHash: 'b'.repeat(64),
      profileId: 'metal-quality-2',
      renderInputId: 'controlled-preview/v2',
    }));
    const html = presentation.renderVisualLabHtml(
      {
        connection: 'connected',
        session: sessionState(before, after),
      },
      { cspSource: 'vscode-webview://unit-test', nonce: 'unit-test-nonce' },
    );

    assert.match(html, /Before \/ After identity delta/);
    assert.match(html, /Source revision<\/dt><dd class="changed">/);
    assert.match(html, /Graphics profile<\/dt><dd class="changed">/);
    assert.match(html, /Render input<\/dt><dd class="changed">/);
    assert.match(html, /Server NaN\/Inf mask · NaN 1 · Inf 0 · masked 1/);
  });

  test('escapes Adapter evidence and applies a nonce-only Webview CSP', () => {
    const hostile = target({
      materialName: '<img src=x onerror="alert(1)">',
      materialPath: 'Assets/<script>alert(2)</script>.mat',
    });
    const html = presentation.renderVisualLabHtml(
      {
        connection: 'connected',
        session: sessionState(frame('before', hostile)),
      },
      { cspSource: 'vscode-webview://unit-test', nonce: 'nonce-value' },
    );

    assert.doesNotMatch(html, /<img src=x onerror=/);
    assert.doesNotMatch(html, /<script>alert\(2\)<\/script>/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(
      html,
      /default-src 'none'; img-src data:; style-src 'nonce-nonce-value'; script-src 'nonce-nonce-value';/,
    );
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  });

  test('rejects oversized or hash-mismatched PNG evidence', () => {
    const valid = frame('before', target()).image;
    assert.match(presentation.validatedPngDataUri(valid), /^data:image\/png;base64,/);
    assert.throws(
      () => presentation.validatedPngDataUri({
        ...valid,
        byteLength: MAX_VISUAL_LAB_PNG_BYTES + 1,
      }),
      /exceeds/,
    );
    assert.throws(
      () => presentation.validatedPngDataUri({
        ...valid,
        sha256: '0'.repeat(64),
      }),
      /SHA-256 does not match/,
    );
  });

  test('displays only a structurally exact server R8 diagnostic mask', () => {
    const valid = frame('before', target()).diagnostic.nanInfMask;
    assert.strictEqual(presentation.validatedNanInfMask(valid), '/w==');
    assert.throws(
      () => presentation.validatedNanInfMask({
        ...valid,
        data: 'AA==',
      }),
      /counts do not match/,
    );
    assert.throws(
      () => presentation.validatedNanInfMask({
        ...valid,
        nanPixelCount: 0,
      }),
      /counts do not match/,
    );
  });
});

function sessionState(
  before?: VisualLabFrameEvidence,
  after?: VisualLabFrameEvidence,
): VisualLabSessionState {
  const currentTarget = after?.target ?? before?.target ?? target();
  return {
    status: 'available',
    target: currentTarget,
    before: before
      ? { status: 'current', slot: 'before', frame: before }
      : { status: 'empty', slot: 'before' },
    after: after
      ? { status: 'current', slot: 'after', frame: after }
      : { status: 'empty', slot: 'after' },
  };
}

function frame(
  slot: 'before' | 'after',
  renderTarget: VisualLabRenderTarget,
): VisualLabFrameEvidence {
  return {
    capability: VISUAL_LAB_ADAPTER_FEATURE,
    slot,
    requestGeneration: slot === 'before' ? 1 : 2,
    target: renderTarget,
    capturedAt: Date.UTC(2026, 6, 24, 0, 0, slot === 'before' ? 0 : 1),
    image: {
      mediaType: 'image/png',
      encoding: 'base64',
      width: 1,
      height: 1,
      byteLength: 68,
      sha256: PNG_SHA256,
      data: PNG_DATA,
    },
    diagnostic: {
      nanInfMask: {
        format: 'r8',
        origin: 'top-left',
        layout: 'row-major',
        encoding: 'base64',
        width: 1,
        height: 1,
        byteLength: 1,
        data: '/w==',
        nanPixelCount: 1,
        infinitePixelCount: 0,
        maskedPixelCount: 1,
      },
    },
  };
}

function target(overrides: {
  readonly sourceHash?: string;
  readonly profileId?: string;
  readonly renderInputId?: string;
  readonly materialName?: string;
  readonly materialPath?: string;
} = {}): VisualLabRenderTarget {
  return {
    selectionId: 'selection-1',
    contextRevision: 'context-1',
    material: {
      name: overrides.materialName ?? 'Preview Material',
      path: overrides.materialPath ?? 'Assets/Preview.mat',
      revision: {
        uri: 'file:///project/Assets/Preview.mat',
        assetGuid: 'material-guid',
        contentHash: '1'.repeat(64),
      },
    },
    source: {
      name: 'Preview Shader',
      path: 'Assets/Preview.shader',
      revision: {
        uri: 'file:///project/Assets/Preview.shader',
        assetGuid: 'shader-guid',
        contentHash: overrides.sourceHash ?? 'a'.repeat(64),
      },
    },
    shaderContext: {
      contextId: 'shader-context-1',
      shaderName: 'Hidden/UnityShaderNav/Preview',
      subShaderIndex: 0,
      passIndex: 0,
      passName: 'Forward',
      stage: 'fragment',
      entryPoint: 'frag',
      keywords: {
        material: ['CAPTURE_TINT'],
        global: [],
        engineAdded: [],
      },
    },
    pipeline: {
      id: 'built-in',
      kind: 'built-in',
      name: 'Built-in Render Pipeline',
    },
    profile: {
      id: overrides.profileId ?? 'metal-quality-1',
      buildTarget: 'StandaloneOSX',
      graphicsApi: 'Metal',
      qualityLevel: 1,
      renderTarget: {
        width: 1,
        height: 1,
        format: 'R8G8B8A8_UNorm',
      },
    },
    colorSpace: 'linear',
    adapter: {
      projectId: 'project-1',
      instanceId: 'adapter-1',
      adapterVersion: '1.0.0',
      unityVersion: '2022.3.62f1',
    },
    renderInputId: overrides.renderInputId ?? 'controlled-preview/v1',
  };
}
