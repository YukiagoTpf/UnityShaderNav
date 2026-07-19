import type { IncludePointContextSelection } from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';

/**
 * Ephemeral server mirror of the client-owned selection. The publication ID
 * is checked again by every consumer, so an old selection can never cross a
 * Published indexed revision boundary.
 */
export class IncludePointContextStore {
  private readonly byFolder = new Map<string, IncludePointContextSelection>();

  get(folderUri: string): IncludePointContextSelection | null {
    return this.byFolder.get(uriKey(folderUri)) ?? null;
  }

  set(folderUri: string, selection: IncludePointContextSelection | null): void {
    const key = uriKey(folderUri);
    if (!selection) {
      this.byFolder.delete(key);
      return;
    }
    this.byFolder.set(key, { ...selection });
  }

  clear(): void {
    this.byFolder.clear();
  }
}

export const includePointContextStore = new IncludePointContextStore();
