import type { IndexStatusSnapshot } from '@unity-shader-nav/shared';
import type { StatusBar, StatusMode } from './statusBar';

interface StatusProjection {
  mode: StatusMode;
  detail?: string;
  tooltip?: string;
}

export class IndexStatusController {
  private lastSequence = -1;
  private sessionEpoch = 0;
  private currentSnapshot: IndexStatusSnapshot | undefined;

  constructor(private readonly statusBar: Pick<StatusBar, 'set'>) {}

  reset(): void {
    this.sessionEpoch++;
    this.lastSequence = -1;
    this.currentSnapshot = undefined;
    this.statusBar.set('starting');
  }

  stop(): void {
    this.sessionEpoch++;
    this.lastSequence = -1;
    this.currentSnapshot = undefined;
    this.statusBar.set('stopped');
  }

  session(): number {
    return this.sessionEpoch;
  }

  current(): IndexStatusSnapshot | undefined {
    return this.currentSnapshot;
  }

  accept(snapshot: IndexStatusSnapshot, session: number): boolean {
    if (session !== this.sessionEpoch) return false;
    if (snapshot.statusSequence <= this.lastSequence) return false;
    this.lastSequence = snapshot.statusSequence;
    this.currentSnapshot = snapshot;
    const projection = projectIndexStatus(snapshot);
    this.statusBar.set(projection.mode, projection.detail, projection.tooltip);
    return true;
  }
}

export function projectIndexStatus(snapshot: IndexStatusSnapshot): StatusProjection {
  const failed = snapshot.workspaces.filter(({ lifecycle }) => lifecycle.state === 'failed');
  if (failed.length > 0) {
    return {
      mode: 'failed',
      detail: `${failed.length} root${failed.length === 1 ? '' : 's'}`,
      tooltip: failed.map(({ folderUri, lifecycle }) => {
        if (lifecycle.state !== 'failed') return folderUri;
        return `${folderUri}: [${lifecycle.failure.category}] ${lifecycle.failure.message}`;
      }).join('\n'),
    };
  }

  const indexing = snapshot.workspaces.filter(({ lifecycle }) => lifecycle.state === 'indexing');
  if (indexing.length > 0) {
    return {
      mode: 'indexing',
      detail: `${indexing.length} root${indexing.length === 1 ? '' : 's'}`,
      tooltip: indexing.map(({ folderUri, lifecycle }) => (
        lifecycle.state === 'indexing'
          ? `${folderUri}: ${lifecycle.operation}`
          : folderUri
      )).join('\n'),
    };
  }

  if (snapshot.workspaces.some(({ mode, lifecycle }) => (
    mode === 'unity' && lifecycle.state === 'ready'
  ))) {
    return { mode: 'ready' };
  }

  return { mode: 'standalone' };
}
