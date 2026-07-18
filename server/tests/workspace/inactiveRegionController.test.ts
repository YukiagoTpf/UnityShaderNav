import type {
  InactiveRegionsParams,
  InactiveRegionsResult,
  Range,
} from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  InactiveRegionController,
  type InactiveRegionControllerHost,
  type InactiveRegionDecoration,
  type InactiveRegionDocument,
} from '../../../client/src/inactiveRegionController';

interface TestDecoration extends InactiveRegionDecoration {
  readonly id: number;
  readonly reason: 'inactive' | 'variant';
  readonly opacity: number;
  disposed: boolean;
}

interface TestEditor {
  readonly id: string;
  document: InactiveRegionDocument;
  readonly applications: Array<{
    decoration: TestDecoration;
    ranges: readonly string[];
  }>;
}

interface TestTimer {
  readonly callback: () => void;
  cancelled: boolean;
}

interface DeferredRequest {
  readonly params: InactiveRegionsParams;
  readonly promise: Promise<InactiveRegionsResult | null>;
  resolve(result: InactiveRegionsResult | null): void;
  reject(error: unknown): void;
}

function deferredRequest(params: InactiveRegionsParams): DeferredRequest {
  let resolve!: (result: InactiveRegionsResult | null) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<InactiveRegionsResult | null>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { params, promise, resolve, reject };
}

function editor(
  id: string,
  uri = `file:///${id}.hlsl`,
  languageId = 'hlsl',
  version = 1,
): TestEditor {
  return {
    id,
    document: { uri, languageId, version },
    applications: [],
  };
}

function encodedRange(range: Range): string {
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
}

function region(
  reason: 'inactive' | 'variant',
  startLine: number,
): InactiveRegionsResult['regions'][number] {
  return {
    reason,
    range: {
      start: { line: startLine, character: 0 },
      end: { line: startLine + 1, character: 0 },
    },
  };
}

function setup(): {
  controller: InactiveRegionController<TestEditor, string, TestTimer, TestDecoration>;
  requests: DeferredRequest[];
  timers: TestTimer[];
  decorations: TestDecoration[];
  reportError: ReturnType<typeof vi.fn>;
  setVisible(editors: readonly TestEditor[]): void;
  setEnabled(uri: string, enabled: boolean): void;
  setOpacity(uri: string, opacity: number): void;
} {
  let visibleEditors: readonly TestEditor[] = [];
  let nextDecorationId = 1;
  const requests: DeferredRequest[] = [];
  const timers: TestTimer[] = [];
  const decorations: TestDecoration[] = [];
  const enabledByUri = new Map<string, boolean>();
  const opacityByUri = new Map<string, number>();
  const reportError = vi.fn();

  const host: InactiveRegionControllerHost<
    TestEditor,
    string,
    TestTimer,
    TestDecoration
  > = {
    describe: (target) => target.document,
    visibleEditors: () => visibleEditors,
    isEnabled: ({ uri }) => enabledByUri.get(uri) ?? true,
    opacity: ({ uri }) => opacityByUri.get(uri) ?? 0.55,
    createDecorations(opacity) {
      const create = (reason: 'inactive' | 'variant'): TestDecoration => {
        const decoration: TestDecoration = {
          id: nextDecorationId++,
          reason,
          opacity,
          disposed: false,
          dispose() {
            decoration.disposed = true;
          },
        };
        decorations.push(decoration);
        return decoration;
      };
      return { inactive: create('inactive'), variant: create('variant') };
    },
    setDecorations(target, decoration, ranges) {
      target.applications.push({
        decoration,
        ranges,
      });
    },
    toRange: encodedRange,
    request(params) {
      const request = deferredRequest(params);
      requests.push(request);
      return request.promise;
    },
    schedule(callback) {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.cancelled = true;
    },
    reportError,
  };

  return {
    controller: new InactiveRegionController(host),
    requests,
    timers,
    decorations,
    reportError,
    setVisible(editors) {
      visibleEditors = editors;
    },
    setEnabled(uri, enabled) {
      enabledByUri.set(uri, enabled);
    },
    setOpacity(uri, opacity) {
      opacityByUri.set(uri, opacity);
    },
  };
}

describe('InactiveRegionController', () => {
  it('renders inactive and variant regions with separate decorations', async () => {
    const harness = setup();
    const target = editor('main');
    harness.setVisible([target]);

    harness.controller.visibleEditorsChanged([target]);
    expect(harness.requests).toHaveLength(1);
    harness.requests[0].resolve({
      version: 1,
      regions: [region('inactive', 2), region('variant', 8)],
    });
    await harness.requests[0].promise;

    expect(target.applications).toHaveLength(2);
    expect(target.applications[0]).toMatchObject({
      decoration: { reason: 'inactive' },
      ranges: ['2:0:3:0'],
    });
    expect(target.applications[1]).toMatchObject({
      decoration: { reason: 'variant' },
      ranges: ['8:0:9:0'],
    });
  });

  it('disposes per-document decorations and cancels debounce work on close', () => {
    const harness = setup();
    const target = editor('closing');
    harness.setVisible([target]);

    harness.controller.visibleEditorsChanged([target]);
    harness.controller.documentChanged(target.document);
    expect(harness.timers).toHaveLength(1);

    harness.controller.documentClosed(target.document.uri);

    expect(harness.decorations).toHaveLength(2);
    expect(harness.decorations.every(({ disposed }) => disposed)).toBe(true);
    expect(harness.timers[0].cancelled).toBe(true);

    harness.timers[0].callback();
    expect(harness.requests).toHaveLength(1);
  });

  it('rejects a response from a closed session after the same URI and version reopen', async () => {
    const harness = setup();
    const original = editor('original', 'file:///same.hlsl', 'hlsl', 1);
    harness.setVisible([original]);
    harness.controller.visibleEditorsChanged([original]);

    harness.controller.documentClosed(original.document.uri);
    const reopened = editor('reopened', original.document.uri, 'hlsl', 1);
    harness.setVisible([reopened]);
    harness.controller.visibleEditorsChanged([reopened]);
    expect(harness.requests).toHaveLength(2);

    harness.requests[0].resolve({ version: 1, regions: [region('inactive', 1)] });
    await harness.requests[0].promise;
    expect(original.applications).toHaveLength(0);
    expect(reopened.applications).toHaveLength(0);

    harness.requests[1].resolve({ version: 1, regions: [region('variant', 4)] });
    await harness.requests[1].promise;
    expect(reopened.applications).toHaveLength(2);
    expect(reopened.applications[1]).toMatchObject({
      decoration: { reason: 'variant' },
      ranges: ['4:0:5:0'],
    });
  });

  it('disposes and recreates decorations only when effective configuration changes', () => {
    const harness = setup();
    const target = editor('configured');
    harness.setVisible([target]);
    harness.controller.visibleEditorsChanged([target]);
    const initial = harness.decorations.slice();

    harness.controller.configurationChanged();
    expect(harness.requests).toHaveLength(1);
    expect(harness.decorations).toHaveLength(2);

    harness.setOpacity(target.document.uri, 0.7);
    harness.controller.configurationChanged();
    expect(initial.every(({ disposed }) => disposed)).toBe(true);
    expect(harness.decorations.slice(2)).toMatchObject([
      { reason: 'inactive', opacity: 0.7, disposed: false },
      { reason: 'variant', opacity: 0.7, disposed: false },
    ]);

    harness.setEnabled(target.document.uri, false);
    harness.controller.configurationChanged();
    expect(harness.decorations.slice(2).every(({ disposed }) => disposed)).toBe(true);

    harness.setEnabled(target.document.uri, true);
    harness.controller.configurationChanged();
    expect(harness.decorations.slice(4)).toMatchObject([
      { reason: 'inactive', opacity: 0.7, disposed: false },
      { reason: 'variant', opacity: 0.7, disposed: false },
    ]);
  });

  it('does not refresh an unchanged editor when another document becomes visible', async () => {
    const harness = setup();
    const existing = editor('existing');
    harness.setVisible([existing]);
    harness.controller.visibleEditorsChanged([existing]);
    harness.requests[0].resolve({ version: 1, regions: [region('inactive', 2)] });
    await harness.requests[0].promise;

    const added = editor('added');
    harness.setVisible([existing, added]);
    harness.controller.visibleEditorsChanged([existing, added]);

    expect(harness.requests).toHaveLength(2);
    harness.requests[1].resolve({ version: 1, regions: [region('variant', 6)] });
    await harness.requests[1].promise;
    expect(existing.applications).toHaveLength(2);
    expect(added.applications).toHaveLength(2);
  });

  it('does not schedule debounce work for an unsupported language', () => {
    const harness = setup();
    const target = editor('notes', 'file:///notes.txt', 'plaintext');
    harness.setVisible([target]);

    harness.controller.documentChanged(target.document);

    expect(harness.timers).toHaveLength(0);
    expect(harness.requests).toHaveLength(0);
    expect(harness.decorations).toHaveLength(0);
  });

  it('applies a debounced edit response only to editors for the changed URI', async () => {
    const harness = setup();
    const changed = editor('changed');
    const untouched = editor('untouched');
    harness.setVisible([changed, untouched]);
    harness.controller.visibleEditorsChanged([changed, untouched]);
    harness.requests[0].resolve({ version: 1, regions: [region('inactive', 1)] });
    harness.requests[1].resolve({ version: 1, regions: [region('variant', 2)] });
    await Promise.all([harness.requests[0].promise, harness.requests[1].promise]);

    changed.document = { ...changed.document, version: 2 };
    harness.controller.documentChanged(changed.document);
    expect(harness.timers).toHaveLength(1);
    harness.timers[0].callback();
    expect(harness.requests).toHaveLength(3);
    harness.requests[2].resolve({ version: 2, regions: [region('variant', 7)] });
    await harness.requests[2].promise;

    expect(changed.applications).toHaveLength(4);
    expect(untouched.applications).toHaveLength(2);
  });
});
