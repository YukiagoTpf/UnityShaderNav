export class RequestSuspender {
  private suspendDepth = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly options: { timeoutMs: number }) {}

  suspend(): void {
    this.suspendDepth++;
  }

  release(): void {
    if (this.suspendDepth === 0) return;
    this.suspendDepth--;
    if (this.suspendDepth > 0) return;

    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async run<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.suspendDepth === 0) return work();

    return new Promise<T | null>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => settle(null), this.options.timeoutMs);
      const settle = (value: T | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      this.waiters.push(() => {
        if (settled) return;
        void work().then(settle, () => settle(null));
      });
    });
  }
}
