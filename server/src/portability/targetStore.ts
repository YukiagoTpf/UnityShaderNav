import type { PortabilityTarget } from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';

function cloneTarget(target: PortabilityTarget): PortabilityTarget {
  return target.kind === 'render-pipeline'
    ? { ...target }
    : { ...target, profile: { ...target.profile } };
}

class PortabilityTargetStore {
  private readonly selections = new Map<string, PortabilityTarget>();

  get(uri: string): PortabilityTarget | undefined {
    const target = this.selections.get(uriKey(uri));
    return target ? cloneTarget(target) : undefined;
  }

  set(uri: string, target: PortabilityTarget): void {
    this.selections.set(uriKey(uri), cloneTarget(target));
  }

  delete(uri: string): void {
    this.selections.delete(uriKey(uri));
  }

  clear(): void {
    this.selections.clear();
  }
}

/** Session-only report target; a document close discards it. */
export const portabilityTargetStore = new PortabilityTargetStore();
