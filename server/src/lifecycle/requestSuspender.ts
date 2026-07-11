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

  async run<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.suspendDepth === 0) return work();

    return new Promise<T | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (value: T | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(resume);
        resolve(value);
      };
      const resume = (): void => {
        if (settled) return;
        void work().then(settle, () => settle(null));
      };

      timer = setTimeout(() => settle(null), this.options.timeoutMs);
      this.waiters.add(resume);
    });
  }
}
