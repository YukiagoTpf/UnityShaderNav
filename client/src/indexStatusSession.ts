import type { IndexStatusSnapshot } from '@unity-shader-nav/shared';
import type { IndexStatusController } from './indexStatus';

interface Disposable {
  dispose(): void;
}

export interface IndexStatusTransport {
  request(): Promise<IndexStatusSnapshot>;
  subscribe(handler: (snapshot: IndexStatusSnapshot) => void): Disposable;
}

export class IndexStatusSession {
  private notification: Disposable | undefined;

  constructor(
    private readonly controller: IndexStatusController,
    private readonly transport: IndexStatusTransport,
    private readonly reportRefreshFailure: (error: unknown) => void,
  ) {}

  subscribe(): void {
    this.notification?.dispose();
    const session = this.controller.session();
    this.notification = this.transport.subscribe((snapshot) => {
      this.controller.accept(snapshot, session);
    });
  }

  starting(): void {
    this.controller.reset();
    this.subscribe();
  }

  running(): void {
    void this.request().catch(this.reportRefreshFailure);
  }

  stopped(): void {
    this.controller.stop();
    this.notification?.dispose();
    this.notification = undefined;
  }

  async request(): Promise<IndexStatusSnapshot> {
    const session = this.controller.session();
    const snapshot = await this.transport.request();
    if (this.controller.accept(snapshot, session)) return snapshot;
    const current = this.controller.current();
    if (current) return current;
    throw new Error('Discarded index status from a previous language-server session');
  }

  dispose(): void {
    this.notification?.dispose();
    this.notification = undefined;
  }
}
