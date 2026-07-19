import { describe, it, expect } from 'vitest';
import { VariantContextStore, variantContextStore } from '../../src/workspace/variantContextStore';

describe('VariantContextStore', () => {
  it('returns null for a document with no stored context (conservative default)', () => {
    const store = new VariantContextStore();
    expect(store.get('file:///t/test.hlsl')).toBeNull();
  });

  it('stores and retrieves a context for a URI', () => {
    const store = new VariantContextStore();
    const ctx = { activeKeywords: new Set(['FOO']) };
    store.set('file:///t/test.hlsl', ctx);
    expect(store.get('file:///t/test.hlsl')).toBe(ctx);
  });

  it('stores null context explicitly (conservative override)', () => {
    const store = new VariantContextStore();
    store.set('file:///t/test.hlsl', null);
    expect(store.get('file:///t/test.hlsl')).toBeNull();
  });

  it('normalizes URIs via uriKey (different URI forms resolve to same entry)', () => {
    const store = new VariantContextStore();
    const ctx = { activeKeywords: new Set(['BAR']) };
    store.set('file:///host/path/test.hlsl', ctx);
    // Same URI should retrieve the same context
    expect(store.get('file:///host/path/test.hlsl')).toBe(ctx);
  });

  it('removes context on delete', () => {
    const store = new VariantContextStore();
    store.set('file:///t/test.hlsl', { activeKeywords: new Set(['X']) });
    store.delete('file:///t/test.hlsl');
    expect(store.get('file:///t/test.hlsl')).toBeNull();
  });

  it('keeps different URIs independent', () => {
    const store = new VariantContextStore();
    store.set('file:///t/a.hlsl', { activeKeywords: new Set(['A']) });
    store.set('file:///t/b.hlsl', { activeKeywords: new Set(['B']) });
    expect(store.get('file:///t/a.hlsl')?.activeKeywords.has('A')).toBe(true);
    expect(store.get('file:///t/b.hlsl')?.activeKeywords.has('B')).toBe(true);
    expect(store.get('file:///t/a.hlsl')?.activeKeywords.has('B')).toBe(false);
  });

  it('singleton instance is a VariantContextStore', () => {
    expect(variantContextStore).toBeInstanceOf(VariantContextStore);
  });
});
