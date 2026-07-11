import type {
  IndexFailure,
  IndexFailureCategory,
  IndexingOperation,
  WorkspaceIndexLifecycle,
} from '@unity-shader-nav/shared';

export class IndexInfrastructureError extends Error {
  constructor(
    readonly category: IndexFailureCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IndexInfrastructureError';
  }
}

export class IndexLifecycle {
  private revision = 0;
  private lifecycle: WorkspaceIndexLifecycle = {
    state: 'indexing',
    operation: 'initial',
  };

  constructor(private readonly onChanged: () => void = () => {}) {}

  snapshot(): WorkspaceIndexLifecycle {
    return this.lifecycle;
  }

  canServe(): boolean {
    return this.lifecycle.state === 'ready'
      || (this.lifecycle.state === 'failed' && this.lifecycle.servingRevision !== undefined);
  }

  canApplyIncrementalChanges(): boolean {
    return this.lifecycle.state === 'ready';
  }

  nextRebuildOperation(): IndexingOperation {
    return this.lifecycle.state === 'failed' ? 'recovery' : 'rebuild';
  }

  begin(operation: IndexingOperation): void {
    if (this.lifecycle.state === 'indexing') {
      throw new Error(`Cannot begin ${operation} while ${this.lifecycle.operation} is in progress`);
    }
    const expected = this.lifecycle.state === 'failed' ? 'recovery' : 'rebuild';
    if (operation !== expected) {
      throw new Error(`Cannot begin ${operation} from ${this.lifecycle.state}; expected ${expected}`);
    }
    // Until atomic candidate publication lands, rebuild clears the mutable
    // index. Do not claim that an older revision remains queryable.
    this.transition({ state: 'indexing', operation });
  }

  complete(warningCount = 0): void {
    if (this.lifecycle.state !== 'indexing') {
      throw new Error(`Cannot complete indexing from ${this.lifecycle.state}`);
    }
    this.revision++;
    this.transition({ state: 'ready', revision: this.revision, warningCount });
  }

  fail(error: unknown): void {
    if (this.lifecycle.state !== 'indexing' && this.lifecycle.state !== 'ready') {
      throw new Error(`Cannot fail indexing from ${this.lifecycle.state}`);
    }
    this.transition({
      state: 'failed',
      failure: failureFrom(error),
    });
  }

  private transition(lifecycle: WorkspaceIndexLifecycle): void {
    this.lifecycle = lifecycle;
    this.onChanged();
  }
}

export function failureFrom(error: unknown): IndexFailure {
  const category = error instanceof IndexInfrastructureError
    ? error.category
    : 'indexing';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.replace(/\s+/g, ' ').trim() || 'Unknown indexing failure';
  return { category, message };
}
