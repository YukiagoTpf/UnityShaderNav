import type { CancellationToken, Disposable } from 'vscode-languageserver/node';
import {
  isRequestCancelledError,
  requestCancelledError,
  throwIfRequestCancelled,
} from './requestCancellation';

export class RequestSuspender {
  private suspendDepth = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: { timeoutMs: number }) {}

  suspend(): void {
    this.suspendDepth++;
  }

  release(): void {
    if (this.suspendDepth === 0) return;
    this.suspendDepth--;
    if (this.suspendDepth > 0) return;

    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  async run<T>(
    work: () => Promise<T>,
    cancellation?: CancellationToken,
  ): Promise<T | null> {
    throwIfRequestCancelled(cancellation);
    if (this.suspendDepth === 0) return work();

    return new Promise<T | null>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let cancellationSubscription: Disposable | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.waiters.delete(resume);
        cancellationSubscription?.dispose();
      };
      const settle = (value: T | null): void => {
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
      const resume = (): void => {
        if (settled) return;
        void work().then(settle, (error: unknown) => {
          if (isRequestCancelledError(error)) {
            cancel();
            return;
          }
          fail(error);
        });
      };

      timer = setTimeout(() => settle(null), this.options.timeoutMs);
      this.waiters.add(resume);
      const subscription = cancellation?.onCancellationRequested(cancel);
      if (settled) {
        subscription?.dispose();
      } else {
        cancellationSubscription = subscription;
        if (cancellation?.isCancellationRequested) cancel();
      }
    });
  }
}
