import { describe, expect, it, vi } from 'vitest';
import {
  LSPErrorCodes,
  type CancellationToken,
} from 'vscode-languageserver/node';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { awaitWithRequestCancellation } from '../../src/lifecycle/requestCancellation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('request cancellation', () => {
  it('detaches one cancelled waiter without cancelling its shared operation', async () => {
    const operation = deferred<number>();
    const cancellation = new CancellationTokenSource();
    const waiter = awaitWithRequestCancellation(operation.promise, cancellation.token);

    cancellation.cancel();

    await expect(waiter).rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
    operation.resolve(42);
    await expect(operation.promise).resolves.toBe(42);
    cancellation.dispose();
  });

  it('disposes a subscription that synchronously cancels before subscribe returns', async () => {
    const operation = deferred<number>();
    const dispose = vi.fn();
    const cancellation = {
      isCancellationRequested: false,
      onCancellationRequested(listener: () => void) {
        listener();
        return { dispose };
      },
    } as CancellationToken;

    const waiter = awaitWithRequestCancellation(operation.promise, cancellation);

    await expect(waiter).rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
    expect(dispose).toHaveBeenCalledOnce();
    operation.resolve(42);
    await expect(operation.promise).resolves.toBe(42);
  });
});
