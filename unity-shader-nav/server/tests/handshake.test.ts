import { describe, it, expect } from 'vitest';
import { createInitializeResult } from '../src/connection';

describe('LSP handshake', () => {
  it('returns text document sync incremental + serverInfo', () => {
    const result = createInitializeResult();
    expect(result.serverInfo?.name).toBe('UnityShaderNav Language Server');
    expect(result.capabilities.textDocumentSync).toBeDefined();
  });

  it('advertises definitionProvider', () => {
    const result = createInitializeResult();
    expect(result.capabilities.definitionProvider).toBe(true);
  });
});
