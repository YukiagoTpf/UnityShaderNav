import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { exactSource } from '../../src/sourceLocation';
import { uriKey } from '../../src/uriKey';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { OpenDocumentReconciler } from '../../src/workspace/openDocumentReconciler';
import { Workspace } from '../../src/workspace/workspace';

const connection = {
  console: { log() {}, warn() {}, error() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

type TransitionStep =
  | {
    readonly kind: 'open';
    readonly openId: number;
    readonly version: number;
    readonly text: string;
  }
  | { readonly kind: 'close'; readonly openId: number };

interface ReconciliationScenario {
  readonly name: string;
  readonly diskText?: string;
  readonly steps: readonly TransitionStep[];
  readonly names: readonly string[];
  readonly rejected: Omit<Extract<TransitionStep, { kind: 'open' }>, 'kind'>;
  readonly current?: Omit<Extract<TransitionStep, { kind: 'open' }>, 'kind'>;
  readonly expectedSymbols: readonly string[];
  readonly expectedDocumentPresent: boolean;
}

interface ReconciliationObservation {
  readonly symbolsBeforeAttemptChecks: readonly string[];
  readonly documentPresent: boolean;
  readonly rejectedAccepted: boolean;
  readonly symbolsAfterRejectedAttempt: readonly string[];
  readonly currentAccepted: boolean | null;
  readonly finalSymbols: readonly string[];
}

const scenarios: readonly ReconciliationScenario[] = [
  {
    name: 'open a live-only document',
    steps: [
      { kind: 'open', openId: 1, version: 1, text: 'float4 OpenedLive() { return 0; }' },
    ],
    names: ['OpenedLive', 'OlderLive'],
    rejected: { openId: 1, version: 0, text: 'float4 OlderLive() { return 0; }' },
    current: { openId: 1, version: 1, text: 'float4 OpenedLive() { return 0; }' },
    expectedSymbols: ['OpenedLive'],
    expectedDocumentPresent: true,
  },
  {
    name: 'edit an existing open session',
    steps: [
      { kind: 'open', openId: 1, version: 1, text: 'float4 BeforeEdit() { return 0; }' },
      { kind: 'open', openId: 1, version: 2, text: 'float4 AfterEdit() { return 0; }' },
    ],
    names: ['BeforeEdit', 'AfterEdit'],
    rejected: { openId: 1, version: 1, text: 'float4 BeforeEdit() { return 0; }' },
    current: { openId: 1, version: 2, text: 'float4 AfterEdit() { return 0; }' },
    expectedSymbols: ['AfterEdit'],
    expectedDocumentPresent: true,
  },
  {
    name: 'close back to a disk baseline',
    diskText: 'float4 SavedBaseline() { return 0; }',
    steps: [
      { kind: 'open', openId: 1, version: 1, text: 'float4 LiveOverlay() { return 0; }' },
      { kind: 'close', openId: 1 },
    ],
    names: ['SavedBaseline', 'LiveOverlay'],
    rejected: { openId: 1, version: 1, text: 'float4 LiveOverlay() { return 0; }' },
    expectedSymbols: ['SavedBaseline'],
    expectedDocumentPresent: true,
  },
  {
    name: 'close a live-only document',
    steps: [
      { kind: 'open', openId: 1, version: 1, text: 'float4 EphemeralLive() { return 0; }' },
      { kind: 'close', openId: 1 },
    ],
    names: ['EphemeralLive'],
    rejected: { openId: 1, version: 1, text: 'float4 EphemeralLive() { return 0; }' },
    expectedSymbols: [],
    expectedDocumentPresent: false,
  },
  {
    name: 'close and reopen at the same version',
    steps: [
      { kind: 'open', openId: 1, version: 1, text: 'float4 ClosedSession() { return 0; }' },
      { kind: 'close', openId: 1 },
      { kind: 'open', openId: 2, version: 1, text: 'float4 ReopenedSession() { return 0; }' },
    ],
    names: ['ClosedSession', 'ReopenedSession'],
    rejected: { openId: 1, version: 1, text: 'float4 ClosedSession() { return 0; }' },
    current: { openId: 2, version: 1, text: 'float4 ReopenedSession() { return 0; }' },
    expectedSymbols: ['ReopenedSession'],
    expectedDocumentPresent: true,
  },
];

describe('open-document reconciliation contract matrix', () => {
  for (const scenario of scenarios) {
    it(`commits the same state through incremental and full replay adapters: ${scenario.name}`, async () => {
      const incremental = await runScenario(scenario, 'incremental');
      const fullReplay = await runScenario(scenario, 'full-replay');
      const expected: ReconciliationObservation = {
        symbolsBeforeAttemptChecks: scenario.expectedSymbols,
        documentPresent: scenario.expectedDocumentPresent,
        rejectedAccepted: false,
        symbolsAfterRejectedAttempt: scenario.expectedSymbols,
        currentAccepted: scenario.current ? true : null,
        finalSymbols: scenario.expectedSymbols,
      };

      expect(incremental).toEqual(expected);
      expect(fullReplay).toEqual(expected);
      expect(fullReplay).toEqual(incremental);
    });
  }
});

describe('prepared source ownership', () => {
  it('keeps an exact source across a provider refresh and releases it on close', () => {
    const reconciler = new OpenDocumentReconciler();
    const document = snapshot(
      'file:///workspace/Prepared.hlsl',
      { openId: 1, version: 1, text: 'float4 Prepared() { return 0; }' },
    );
    const source = exactSource(document.text);

    expect(reconciler.acceptDocument(document, source)).toBe(true);
    const desired = reconciler.desired(uriKey(document.uri));
    reconciler.captureProvider(() => [{ ...document }], () => true, true);

    expect(reconciler.desired(uriKey(document.uri))).toBe(desired);
    expect(desired).toEqual({
      kind: 'open',
      document,
      source,
    });

    expect(reconciler.acceptClose(document.uri, document.openId)).toBe(true);
    expect(reconciler.desired(uriKey(document.uri))).toEqual({
      kind: 'closed',
      uri: document.uri,
      openId: document.openId,
      tombstone: true,
    });
  });

  it('rejects divergent text for the same open attempt without replacing its source', () => {
    const reconciler = new OpenDocumentReconciler();
    const document = snapshot(
      'file:///workspace/Prepared.hlsl',
      { openId: 1, version: 1, text: 'float4 Original() { return 0; }' },
    );
    const source = exactSource(document.text);

    expect(reconciler.acceptDocument(document, source)).toBe(true);
    const desired = reconciler.desired(uriKey(document.uri));
    expect(reconciler.acceptDocument({
      ...document,
      text: 'float4 Divergent() { return 0; }',
    })).toBe(false);
    expect(reconciler.desired(uriKey(document.uri))).toBe(desired);
    expect(desired).toEqual({
      kind: 'open',
      document,
      source,
    });
  });

  it('keeps the original exact source when the same attempt supplies an equivalent source', () => {
    const reconciler = new OpenDocumentReconciler();
    const document = snapshot(
      'file:///workspace/Prepared.hlsl',
      { openId: 1, version: 1, text: 'float4 Prepared() { return 0; }' },
    );
    const source = exactSource(document.text);

    expect(reconciler.acceptDocument(document, source)).toBe(true);
    const desired = reconciler.desired(uriKey(document.uri));
    const equivalentSource = exactSource(document.text);
    expect(equivalentSource).not.toBe(source);

    expect(reconciler.acceptDocument({ ...document }, equivalentSource)).toBe(true);
    expect(reconciler.desired(uriKey(document.uri))).toBe(desired);
    expect(desired).toEqual({
      kind: 'open',
      document,
      source,
    });
  });
});

async function runScenario(
  scenario: ReconciliationScenario,
  adapter: 'incremental' | 'full-replay',
): Promise<ReconciliationObservation> {
  const root = await mkdtemp(join(tmpdir(), `usn-reconcile-${adapter}-`));
  const uri = pathToFileURL(join(root, 'Document.hlsl')).href;
  const rebuildStarted = deferred();
  const releaseRebuild = deferred();
  let parserReadinessAttempts = 0;

  try {
    if (scenario.diskText) await writeFile(join(root, 'Document.hlsl'), scenario.diskText);
    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
      releaseVersion: null,
      async ensureParserReady() {
        parserReadinessAttempts++;
        if (adapter === 'full-replay' && parserReadinessAttempts === 2) {
          rebuildStarted.resolve();
          await releaseRebuild.promise;
        }
      },
    });
    await workspace.initialize(connection);

    if (adapter === 'incremental') {
      for (const step of scenario.steps) await dispatch(workspace, uri, step);
    } else {
      const rebuilding = workspace.rebuild(connection);
      await rebuildStarted.promise;
      const queued = scenario.steps.map((step) => dispatch(workspace, uri, step));
      releaseRebuild.resolve();
      await Promise.all([rebuilding, ...queued]);
    }

    const symbolsBeforeAttemptChecks = symbolNames(workspace, scenario.names);
    const documentPresent = await workspace.documentSymbols({ uri }) !== null;
    const rejectedAccepted = await workspace.updateDocument(snapshot(uri, scenario.rejected));
    const symbolsAfterRejectedAttempt = symbolNames(workspace, scenario.names);
    const currentAccepted = scenario.current
      ? await workspace.updateDocument(snapshot(uri, scenario.current))
      : null;

    return {
      symbolsBeforeAttemptChecks,
      documentPresent,
      rejectedAccepted,
      symbolsAfterRejectedAttempt,
      currentAccepted,
      finalSymbols: symbolNames(workspace, scenario.names),
    };
  } finally {
    releaseRebuild.resolve();
    await rm(root, { recursive: true, force: true });
  }
}

async function dispatch(
  workspace: Workspace,
  uri: string,
  step: TransitionStep,
): Promise<void> {
  if (step.kind === 'open') {
    await workspace.updateDocument(snapshot(uri, step));
    return;
  }
  await workspace.closeDocument({ uri, openId: step.openId });
}

function snapshot(
  uri: string,
  input: Omit<Extract<TransitionStep, { kind: 'open' }>, 'kind'>,
): IndexedDocumentSnapshot {
  return { uri, languageId: 'hlsl', ...input };
}

function symbolNames(workspace: Workspace, names: readonly string[]): string[] {
  return names.filter((name) => (
    workspace.workspaceSymbols(name).some((symbol) => symbol.name === name)
  ));
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
