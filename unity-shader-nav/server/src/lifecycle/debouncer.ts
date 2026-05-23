export type DebouncerMode = 'incremental' | 'rebuild';

export interface DebouncerOptions {
  windowMs: number;
  threshold: number;
}

export class Debouncer<T> {
  private timer: NodeJS.Timeout | undefined;
  private buffer: T[] = [];

  constructor(
    private readonly options: DebouncerOptions,
    private readonly onFlush: (batch: T[], mode: DebouncerMode) => void,
  ) {}

  push(item: T): void {
    this.buffer.push(item);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.options.windowMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    const mode: DebouncerMode = batch.length > this.options.threshold ? 'rebuild' : 'incremental';
    this.onFlush(batch, mode);
  }
}
