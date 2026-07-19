import type { VariantContext } from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';

/**
 * Per-document store of the active VariantContext. Defaults to null
 * (conservative) for every document. Survives re-indexing; cleared on close.
 */
export class VariantContextStore {
  private readonly byUri = new Map<string, VariantContext | null>();

  get(uri: string): VariantContext | null {
    return this.byUri.get(uriKey(uri)) ?? null;
  }

  set(uri: string, context: VariantContext | null): void {
    this.byUri.set(uriKey(uri), context);
  }

  delete(uri: string): void {
    this.byUri.delete(uriKey(uri));
  }
}

/** Module-level singleton shared across handlers. */
export const variantContextStore = new VariantContextStore();
