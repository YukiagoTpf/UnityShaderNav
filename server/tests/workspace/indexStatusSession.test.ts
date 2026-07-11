import { describe, expect, it, vi } from 'vitest';
import type { IndexStatusSnapshot } from '@unity-shader-nav/shared';
import { IndexStatusController } from '../../../client/src/indexStatus';
import {
  IndexStatusSession,
  type IndexStatusTransport,
} from '../../../client/src/indexStatusSession';

function snapshot(statusSequence: number): IndexStatusSnapshot {
  return { statusSequence, workspaces: [] };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup(): {
  statusBar: { set: ReturnType<typeof vi.fn> };
  requests: Array<ReturnType<typeof deferred<IndexStatusSnapshot>>>;
  handlers: Array<(snapshot: IndexStatusSnapshot) => void>;
  disposals: Array<ReturnType<typeof vi.fn>>;
  reportFailure: ReturnType<typeof vi.fn>;
  session: IndexStatusSession;
} {
  const statusBar = { set: vi.fn() };
  const requests: Array<ReturnType<typeof deferred<IndexStatusSnapshot>>> = [];
  const handlers: Array<(snapshot: IndexStatusSnapshot) => void> = [];
  const disposals: Array<ReturnType<typeof vi.fn>> = [];
  const transport: IndexStatusTransport = {
    request() {
      const request = deferred<IndexStatusSnapshot>();
      requests.push(request);
      return request.promise;
    },
    subscribe(handler) {
      handlers.push(handler);
      const dispose = vi.fn();
      disposals.push(dispose);
      return { dispose };
    },
  };
  const reportFailure = vi.fn();
  return {
    statusBar,
    requests,
    handlers,
    disposals,
    reportFailure,
    session: new IndexStatusSession(
      new IndexStatusController(statusBar),
      transport,
      reportFailure,
    ),
  };
}

describe('IndexStatusSession', () => {
  it('re-subscribes per session and rejects delayed notifications after stop', () => {
    const { session, handlers, disposals, statusBar } = setup();
    session.subscribe();
    const oldHandler = handlers[0];

    session.starting();
    expect(disposals[0]).toHaveBeenCalledTimes(1);
    const currentHandler = handlers[1];
    oldHandler(snapshot(99));
    expect(statusBar.set).toHaveBeenLastCalledWith('starting');

    currentHandler(snapshot(0));
    expect(statusBar.set).toHaveBeenLastCalledWith('standalone', undefined, undefined);
    session.stopped();
    expect(disposals[1]).toHaveBeenCalledTimes(1);
    currentHandler(snapshot(100));
    expect(statusBar.set).toHaveBeenLastCalledWith('stopped');
  });

  it('drops an old pull response and returns the current session snapshot', async () => {
    const { session, requests, handlers } = setup();
    session.subscribe();
    const oldRequest = session.request();
    session.starting();
    handlers[1](snapshot(0));

    requests[0].resolve(snapshot(99));
    await expect(oldRequest).resolves.toEqual(snapshot(0));
  });

  it('reports a Running refresh failure without rejecting the caller', async () => {
    const { session, requests, reportFailure } = setup();
    session.subscribe();
    session.running();
    requests[0].reject(new Error('transport unavailable'));
    await Promise.resolve();
    await Promise.resolve();

    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: 'transport unavailable',
    }));
  });
});
