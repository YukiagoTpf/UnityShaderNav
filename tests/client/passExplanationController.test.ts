import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  MATERIAL_CONTEXT_CHANGED_NOTIFICATION,
  PASS_EXPLANATION_REQUEST,
} from '@unity-shader-nav/shared';

interface Disposable {
  dispose(): void;
}

interface Snapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'stale' | 'failed';
  readonly sourceUri?: string;
  readonly answer?: unknown;
  readonly message?: string;
}

interface TestController extends Disposable {
  explainCurrentPass(): Promise<void>;
  inspect(): Snapshot;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

class FakeCancellationToken {
  isCancellationRequested = false;
  disposed = false;
}

class FakeCancellationTokenSource {
  readonly token = new FakeCancellationToken();

  cancel(): void {
    this.token.isCancellationRequested = true;
  }

  dispose(): void {
    this.token.disposed = true;
  }
}

class FakeCancellationError extends Error {}

class FakePassExplanationClientSession {
  private generation = 0;
  private value: Snapshot = { status: 'idle' };
  private sources: readonly string[] = [];

  snapshot(): Snapshot {
    return this.value;
  }

  sourceUris(): readonly string[] {
    return this.sources;
  }

  begin(sourceUri: string): number {
    const generation = ++this.generation;
    this.sources = [sourceUri];
    this.value = { status: 'loading', sourceUri };
    return generation;
  }

  settle(generation: number, sourceUri: string, answer: unknown): boolean {
    // Mirrors the real session: only a loading snapshot may settle.
    if (!this.isCurrent(generation, sourceUri) || this.value.status !== 'loading') {
      return false;
    }
    const cited = (
      answer as { readonly citationSourceUris?: readonly string[] }
    ).citationSourceUris ?? [];
    this.sources = [...new Set([sourceUri, ...cited])];
    this.value = { status: 'ready', sourceUri, answer };
    return true;
  }

  fail(generation: number, sourceUri: string, message: string): boolean {
    // Mirrors the real session's `status !== 'loading'` guard. Without it a
    // post-settle failure looked recoverable here and controller tests could
    // not observe the swallowed error path at all.
    if (!this.isCurrent(generation, sourceUri) || this.value.status !== 'loading') {
      return false;
    }
    this.value = { status: 'failed', sourceUri, message };
    return true;
  }

  invalidate(reason: 'source-changed' | 'material-context-changed'): boolean {
    if (
      !this.value.sourceUri
      || (this.value.status !== 'loading' && this.value.status !== 'ready')
    ) return false;
    this.generation++;
    this.value = {
      status: 'stale',
      sourceUri: this.value.sourceUri,
      message: reason,
    };
    return true;
  }

  explainFromShaderSourceOnly(message: string): void {
    this.generation++;
    this.sources = [];
    this.value = { status: 'idle', message };
  }

  private isCurrent(generation: number, sourceUri: string): boolean {
    return generation === this.generation
      && this.value.status === 'loading'
      && this.value.sourceUri === sourceUri;
  }
}

interface TestRequest {
  readonly params: { readonly textDocument: { readonly uri: string } };
  readonly token: FakeCancellationToken;
  readonly completion: Deferred<unknown>;
}

class FakeRequestApi {
  readonly requests: TestRequest[] = [];
  private materialContextHandler: (() => void) | undefined;

  request(params: unknown, token: FakeCancellationToken): Promise<unknown> {
    const completion = deferred<unknown>();
    this.requests.push({
      params: params as TestRequest['params'],
      token,
      completion,
    });
    return completion.promise;
  }

  onMaterialContextChanged(handler: () => void): Disposable {
    this.materialContextHandler = handler;
    return {
      dispose: () => {
        if (this.materialContextHandler === handler) {
          this.materialContextHandler = undefined;
        }
      },
    };
  }

  emitMaterialContextChanged(): void {
    assert.ok(this.materialContextHandler);
    this.materialContextHandler();
  }
}

interface ControllerModule {
  createPassExplanationController(
    api: FakeRequestApi,
    reportError: (message: string, error: unknown) => void,
  ): TestController;
  createLanguageClientPassExplanationApi(client: unknown, notifications: unknown): {
    request(params: unknown, token: FakeCancellationToken): Promise<unknown>;
    onMaterialContextChanged(handler: () => void): Disposable;
  };
}

type SourceChangedHandler = (
  event: { readonly document: { readonly uri: { toString(): string } } },
) => void;

const sourceChangedHandlers = new Set<SourceChangedHandler>();
type WatchedSourceHandler = (
  uri: { readonly toString: () => string },
) => void;
const watchedSourceChangedHandlers = new Set<WatchedSourceHandler>();
const watchedSourceCreatedHandlers = new Set<WatchedSourceHandler>();
const watchedSourceDeletedHandlers = new Set<WatchedSourceHandler>();
const watchedPatterns: string[] = [];
let activeEditor: {
  readonly document: {
    readonly languageId: string;
    readonly uri: { toString(): string };
  };
} | undefined;

const vscodeMock = {
  CancellationTokenSource: FakeCancellationTokenSource,
  CancellationError: FakeCancellationError,
  ViewColumn: { Beside: 2 },
  Uri: {
    parse: (value: string) => ({ toString: () => value }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
  },
  workspace: {
    onDidChangeTextDocument: (handler: SourceChangedHandler): Disposable => {
      sourceChangedHandlers.add(handler);
      return {
        dispose: () => {
          sourceChangedHandlers.delete(handler);
        },
      };
    },
    createFileSystemWatcher: (pattern: string) => {
      watchedPatterns.push(pattern);
      return {
      onDidChange: (handler: WatchedSourceHandler): Disposable => {
        watchedSourceChangedHandlers.add(handler);
        return {
          dispose: () => watchedSourceChangedHandlers.delete(handler),
        };
      },
      onDidCreate: (handler: WatchedSourceHandler): Disposable => {
        watchedSourceCreatedHandlers.add(handler);
        return {
          dispose: () => watchedSourceCreatedHandlers.delete(handler),
        };
      },
      onDidDelete: (handler: WatchedSourceHandler): Disposable => {
        watchedSourceDeletedHandlers.add(handler);
        return {
          dispose: () => watchedSourceDeletedHandlers.delete(handler),
        };
      },
      dispose() {},
      };
    },
  },
  window: {
    get activeTextEditor() {
      return activeEditor;
    },
    createWebviewPanel: () => {
      let disposeHandler: (() => void) | undefined;
      return {
        webview: { html: '' },
        viewColumn: 2,
        reveal() {},
        onDidDispose(handler: () => void): Disposable {
          disposeHandler = handler;
          return { dispose() {} };
        },
        dispose() {
          const handler = disposeHandler;
          disposeHandler = undefined;
          handler?.();
        },
      };
    },
  },
};

let renderHook: ((snapshot: Snapshot) => void) | undefined;

const presentationMock = {
  PassExplanationClientSession: FakePassExplanationClientSession,
  passExplanationSourceUris: (
    requestUri: string,
    answer: { readonly citationSourceUris?: readonly string[] },
  ) => [...new Set([requestUri, ...(answer.citationSourceUris ?? [])])],
  renderPassExplanationHtml: (snapshot: Snapshot) => {
    renderHook?.(snapshot);
    return JSON.stringify(snapshot);
  },
};

type ModuleLoad = (
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) => unknown;
const nodeModule = require('node:module') as { _load: ModuleLoad };
const originalModuleLoad = nodeModule._load;
nodeModule._load = function loadWithVscodeMock(
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
): unknown {
  if (request === 'vscode') return vscodeMock;
  if (request === './passExplanationPresentation') return presentationMock;
  return originalModuleLoad.call(this, request, parent, isMain);
};

let controllerModule: ControllerModule;
const controllerModulePath = path.resolve(
  __dirname,
  '../../../client/out/passExplanationController.js',
);
try {
  controllerModule = require(controllerModulePath) as ControllerModule;
} finally {
  nodeModule._load = originalModuleLoad;
  delete require.cache[controllerModulePath];
}

const controllers: TestController[] = [];

suite('Pass explanation controller request lifecycle', () => {
  setup(() => {
    activeEditor = undefined;
    sourceChangedHandlers.clear();
    watchedSourceChangedHandlers.clear();
    watchedSourceCreatedHandlers.clear();
    watchedSourceDeletedHandlers.clear();
    watchedPatterns.length = 0;
    controllers.length = 0;
  });

  teardown(() => {
    renderHook = undefined;
    for (const controller of controllers.splice(0)) controller.dispose();
  });

  test('forwards the caller cancellation token to LanguageClient.sendRequest', async () => {
    const calls: unknown[][] = [];
    const client = {
      sendRequest: (...args: unknown[]): Promise<unknown> => {
        calls.push(args);
        return Promise.resolve({});
      },
      onNotification: () => ({ dispose() {} }),
    };
    const api = controllerModule.createLanguageClientPassExplanationApi(client, {
      on: () => ({ dispose() {} }),
    });
    const token = new FakeCancellationToken();
    const params = {
      textDocument: { uri: 'file:///project/Assets/Forward.shader' },
    };

    await api.request(params, token);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], PASS_EXPLANATION_REQUEST);
    assert.deepStrictEqual(calls[0][1], params);
    assert.strictEqual(calls[0][2], token);
  });

  test('subscribes to Material Context changes through the shared hub', () => {
    // materialContextController subscribes to the same method. LanguageClient
    // keeps one handler per method, so a direct client.onNotification here was
    // silently evicted and this panel never invalidated on a Material change.
    const clientRegistrations: string[] = [];
    const hubRegistrations: string[] = [];
    const client = {
      sendRequest: () => Promise.resolve({}),
      onNotification: (method: string) => {
        clientRegistrations.push(method);
        return { dispose() {} };
      },
    };
    const api = controllerModule.createLanguageClientPassExplanationApi(client, {
      on: (method: string) => {
        hubRegistrations.push(method);
        return { dispose() {} };
      },
    });

    api.onMaterialContextChanged(() => {});

    assert.deepStrictEqual(clientRegistrations, []);
    assert.deepStrictEqual(hubRegistrations, [MATERIAL_CONTEXT_CHANGED_NOTIFICATION]);
  });

  test('cancels a superseded generation and reports only the current error', async () => {
    const sourceUri = 'file:///project/Assets/Forward.shader';
    setActiveShader(sourceUri);
    const api = new FakeRequestApi();
    const reported: Array<{ readonly message: string; readonly error: unknown }> = [];
    const controller = track(controllerModule.createPassExplanationController(
      api,
      (message, error) => reported.push({ message, error }),
    ));

    const firstRun = controller.explainCurrentPass();
    const secondRun = controller.explainCurrentPass();

    assert.strictEqual(api.requests.length, 2);
    assert.strictEqual(api.requests[0].token.isCancellationRequested, true);
    assert.strictEqual(api.requests[0].token.disposed, true);
    const obsoleteError = new Error('obsolete failure');
    api.requests[0].completion.reject(obsoleteError);
    await firstRun;
    assert.strictEqual(controller.inspect().status, 'loading');
    assert.deepStrictEqual(reported, []);

    const currentError = new Error('current failure');
    api.requests[1].completion.reject(currentError);
    await secondRun;

    assert.strictEqual(controller.inspect().status, 'failed');
    assert.strictEqual(api.requests[1].token.isCancellationRequested, false);
    assert.strictEqual(api.requests[1].token.disposed, true);
    assert.deepStrictEqual(reported, [{
      message: 'Failed to explain the current Pass',
      error: currentError,
    }]);
  });

  test('cancels requests on source, Material Context, and controller disposal', async () => {
    const sourceUri = 'file:///project/Assets/Forward.shader';
    setActiveShader(sourceUri);
    const api = new FakeRequestApi();
    const reported: unknown[] = [];
    const controller = track(controllerModule.createPassExplanationController(
      api,
      (_message, error) => reported.push(error),
    ));

    const sourceRun = controller.explainCurrentPass();
    emitSourceChanged(sourceUri);
    assertCancelled(api.requests[0]);
    api.requests[0].completion.resolve({ request: 'source-obsolete' });
    await sourceRun;
    assert.strictEqual(controller.inspect().status, 'stale');

    const materialRun = controller.explainCurrentPass();
    api.emitMaterialContextChanged();
    assertCancelled(api.requests[1]);
    api.requests[1].completion.reject(new Error('material-obsolete'));
    await materialRun;
    assert.strictEqual(controller.inspect().status, 'stale');

    const disposeRun = controller.explainCurrentPass();
    const snapshotAtDispose = controller.inspect();
    controller.dispose();
    assertCancelled(api.requests[2]);
    api.requests[2].completion.resolve({ request: 'disposed-obsolete' });
    await disposeRun;

    assert.deepStrictEqual(controller.inspect(), snapshotAtDispose);
    assert.deepStrictEqual(reported, []);
  });

  test('reports a failure raised after the answer already settled', async () => {
    // `fail` only transitions away from 'loading', so a throw once the snapshot
    // is already 'ready' — rendering the settled answer, for instance — made the
    // controller skip both the panel refresh and the only path to the output
    // channel, leaving the panel on stale loading markup with nothing logged.
    const requestUri = 'file:///project/Assets/Shaders/Forward.shader';
    setActiveShader(requestUri);
    const api = new FakeRequestApi();
    const reported: unknown[] = [];
    const controller = track(controllerModule.createPassExplanationController(
      api,
      (message, error) => { reported.push({ message, error }); },
    ));
    const renderFailure = new Error('render defect');
    renderHook = (snapshot) => {
      if (snapshot.status === 'ready') throw renderFailure;
    };

    const run = controller.explainCurrentPass();
    api.requests[0].completion.resolve({});
    await run;

    assert.strictEqual(reported.length, 1);
    assert.deepStrictEqual(reported[0], {
      message: 'Failed to explain the current Pass',
      error: renderFailure,
    });
  });

  test('invalidates a ready answer when any cited source changes', async () => {
    const requestUri = 'file:///project/Assets/Includes/Lighting.hlsl';
    const shaderUri = 'file:///project/Assets/Shaders/Forward.shader';
    setActiveShader(requestUri);
    const api = new FakeRequestApi();
    const controller = track(controllerModule.createPassExplanationController(
      api,
      () => assert.fail('a source invalidation must not report an error'),
    ));

    const run = controller.explainCurrentPass();
    api.requests[0].completion.resolve({
      citationSourceUris: [shaderUri],
    });
    await run;
    assert.strictEqual(controller.inspect().status, 'ready');

    emitSourceChanged(shaderUri);

    assert.strictEqual(controller.inspect().status, 'stale');
  });

  test('rejects an answer when a newly discovered citation changed in flight', async () => {
    const requestUri = 'file:///project/Assets/Includes/Lighting.hlsl';
    const shaderUri = 'file:///project/Assets/Shaders/Forward.shader';
    setActiveShader(requestUri);
    const api = new FakeRequestApi();
    const controller = track(controllerModule.createPassExplanationController(
      api,
      () => assert.fail('a freshness refusal must not report an error'),
    ));

    const run = controller.explainCurrentPass();
    emitSourceChanged(shaderUri);
    assert.strictEqual(
      api.requests[0].token.isCancellationRequested,
      false,
      'an unrelated URI is retained until the answer reveals its citations',
    );
    api.requests[0].completion.resolve({
      citationSourceUris: [shaderUri],
    });
    await run;

    assert.strictEqual(controller.inspect().status, 'stale');
    assert.strictEqual(controller.inspect().answer, undefined);
  });

  test('invalidates ready and in-flight answers after external Material mutations', async () => {
    const sourceUri = 'file:///project/Assets/Shaders/Forward.shader';
    const materialUri = 'file:///project/Assets/Materials/Forward.mat';
    setActiveShader(sourceUri);
    const api = new FakeRequestApi();
    const controller = track(controllerModule.createPassExplanationController(
      api,
      () => assert.fail('a file-system invalidation must not report an error'),
    ));

    const run = controller.explainCurrentPass();
    assert.deepStrictEqual(watchedPatterns, [
      '**/*.{shader,hlsl,cginc,hlslinc,compute,mat,meta}',
    ]);
    api.requests[0].completion.resolve({
      citationSourceUris: [materialUri],
    });
    await run;
    assert.strictEqual(controller.inspect().status, 'ready');

    emitWatchedSourceChanged(materialUri);

    assert.strictEqual(controller.inspect().status, 'stale');

    const inFlight = controller.explainCurrentPass();
    emitWatchedSourceChanged(materialUri);
    api.requests[1].completion.resolve({
      citationSourceUris: [materialUri],
    });
    await inFlight;

    assert.strictEqual(controller.inspect().status, 'stale');
    assert.strictEqual(controller.inspect().answer, undefined);
  });

  test('invalidates exact cited sidecars without mapping arbitrary .meta files', async () => {
    const requestUri = 'file:///project/Assets/Includes/Lighting.hlsl';
    const shaderUri = 'file:///project/Assets/Shaders/Forward.shader';
    const shaderSidecarUri = `${shaderUri}.meta`;
    const unrelatedMetaUri = 'file:///project/Assets/Elsewhere/Forward.shader.meta';
    setActiveShader(requestUri);
    const api = new FakeRequestApi();
    const controller = track(controllerModule.createPassExplanationController(
      api,
      () => assert.fail('a sidecar invalidation must not report an error'),
    ));

    const readyRun = controller.explainCurrentPass();
    api.requests[0].completion.resolve({
      citationSourceUris: [shaderUri],
    });
    await readyRun;
    assert.strictEqual(controller.inspect().status, 'ready');

    emitWatchedSourceCreated(unrelatedMetaUri);
    assert.strictEqual(
      controller.inspect().status,
      'ready',
      'an unrelated .meta basename must not invalidate cited evidence',
    );
    emitWatchedSourceCreated(shaderSidecarUri);
    assert.strictEqual(controller.inspect().status, 'stale');

    const inFlight = controller.explainCurrentPass();
    emitWatchedSourceDeleted(shaderSidecarUri);
    assert.strictEqual(
      api.requests[1].token.isCancellationRequested,
      false,
      'a future citation sidecar is retained until the answer reveals it',
    );
    api.requests[1].completion.resolve({
      citationSourceUris: [shaderUri],
    });
    await inFlight;

    assert.strictEqual(controller.inspect().status, 'stale');
    assert.strictEqual(controller.inspect().answer, undefined);
  });
});

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function setActiveShader(sourceUri: string): void {
  activeEditor = {
    document: {
      languageId: 'shaderlab',
      uri: { toString: () => sourceUri },
    },
  };
}

function emitSourceChanged(sourceUri: string): void {
  const event = {
    document: {
      uri: { toString: () => sourceUri },
    },
  };
  for (const handler of [...sourceChangedHandlers]) handler(event);
}

function emitWatchedSourceChanged(sourceUri: string): void {
  const uri = { toString: () => sourceUri };
  for (const handler of [...watchedSourceChangedHandlers]) handler(uri);
}

function emitWatchedSourceCreated(sourceUri: string): void {
  const uri = { toString: () => sourceUri };
  for (const handler of [...watchedSourceCreatedHandlers]) handler(uri);
}

function emitWatchedSourceDeleted(sourceUri: string): void {
  const uri = { toString: () => sourceUri };
  for (const handler of [...watchedSourceDeletedHandlers]) handler(uri);
}

function assertCancelled(request: TestRequest): void {
  assert.strictEqual(request.token.isCancellationRequested, true);
  assert.strictEqual(request.token.disposed, true);
}

function track(controller: TestController): TestController {
  controllers.push(controller);
  return controller;
}
