import type { SelectedMaterialContext } from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';

export interface StoredMaterialContext {
  readonly publicationId: string;
  readonly context: SelectedMaterialContext;
}

/** Ephemeral, revision-bound evidence overlay; never enters the index/cache. */
export class MaterialContextStore {
  private readonly byFolder = new Map<string, StoredMaterialContext>();

  get(folderUri: string): StoredMaterialContext | null {
    return this.byFolder.get(uriKey(folderUri)) ?? null;
  }

  set(folderUri: string, value: StoredMaterialContext | null): void {
    const key = uriKey(folderUri);
    if (!value) {
      this.byFolder.delete(key);
      return;
    }
    this.byFolder.set(key, value);
  }

  clear(): void {
    this.byFolder.clear();
  }
}

export const materialContextStore = new MaterialContextStore();
