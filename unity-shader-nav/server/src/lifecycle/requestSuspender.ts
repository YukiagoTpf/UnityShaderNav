export class RequestSuspender {
  private suspended = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly options: { timeoutMs: number }) {}

  suspend(): void {
    this.suspended = true;
  }

  release(): void {
    this.suspended = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async run<T>(work: () => Promise<T>): Promise<T | null> {
    if (!this.suspended) return work();

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
