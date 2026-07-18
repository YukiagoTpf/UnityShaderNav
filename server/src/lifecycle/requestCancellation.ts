import {
  LSPErrorCodes,
  ResponseError,
  type CancellationToken,
  type Disposable,
} from 'vscode-languageserver/node';

export function requestCancelledError(): ResponseError<void> {
  return new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled');
}

export function throwIfRequestCancelled(token?: CancellationToken): void {
  if (token?.isCancellationRequested) throw requestCancelledError();
}

export function isRequestCancelledError(error: unknown): boolean {
  return error instanceof ResponseError
    && error.code === LSPErrorCodes.RequestCancelled;
}

const REQUEST_LOOP_YIELD_INTERVAL = 256;

/**
 * Check cancellation in every loop iteration and periodically yield a macrotask
 * so a cancellation notification can be delivered during CPU-bound request work.
 */
export function cooperativeRequestCheckpoint(
  processedCount: number,
  token?: CancellationToken,
): Promise<void> | undefined {
  throwIfRequestCancelled(token);
  if (!token || processedCount % REQUEST_LOOP_YIELD_INTERVAL !== 0) {
    return undefined;
  }

  return new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => throwIfRequestCancelled(token));
}

/** Stop this caller's wait without owning or cancelling the shared operation. */
export function awaitWithRequestCancellation<T>(
  operation: PromiseLike<T>,
  token?: CancellationToken,
): Promise<T> {
  throwIfRequestCancelled(token);
  if (!token) return Promise.resolve(operation);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancellationSubscription: Disposable | undefined;
    const cleanup = (): void => {
      cancellationSubscription?.dispose();
      cancellationSubscription = undefined;
    };
    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = (): void => fail(requestCancelledError());

    void Promise.resolve(operation).then(succeed, fail);
    const subscription = token.onCancellationRequested(cancel);
    if (settled) {
      subscription.dispose();
    } else {
      cancellationSubscription = subscription;
      if (token.isCancellationRequested) cancel();
    }
  });
}
