import { describe, expect, it } from 'vitest';
import { IncludePointContextStore } from '../../src/workspace/includePointContextStore';

describe('IncludePointContextStore', () => {
  it('keeps a session-only selection per canonical workspace folder', () => {
    const store = new IncludePointContextStore();
    const selection = { publicationId: 'publication-1', contextId: 'context-1' };
    store.set('file:///Project/My%20Folder', selection);

    expect(store.get('file:///Project/My Folder')).toEqual(selection);
    expect(store.get('file:///Other')).toBeNull();
  });

  it('copies inputs and supports explicit Auto/clear', () => {
    const store = new IncludePointContextStore();
    const selection = { publicationId: 'publication-1', contextId: 'context-1' };
    store.set('file:///Project', selection);
    expect(store.get('file:///Project')).not.toBe(selection);

    store.set('file:///Project', null);
    expect(store.get('file:///Project')).toBeNull();
    store.set('file:///Project', selection);
    store.clear();
    expect(store.get('file:///Project')).toBeNull();
  });
});
