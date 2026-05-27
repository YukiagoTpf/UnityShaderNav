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

  it('advertises documentSymbolProvider', () => {
    const result = createInitializeResult();
    expect(result.capabilities.documentSymbolProvider).toBe(true);
  });

  it('advertises referencesProvider', () => {
    const result = createInitializeResult();
    expect(result.capabilities.referencesProvider).toBe(true);
  });

  it('advertises documentHighlightProvider', () => {
    const result = createInitializeResult();
    expect(result.capabilities.documentHighlightProvider).toBe(true);
  });

  it('advertises completionProvider', () => {
    const result = createInitializeResult();
    expect(result.capabilities.completionProvider).toMatchObject({
      triggerCharacters: ['.'],
    });
  });

  it('advertises semanticTokensProvider', () => {
    const result = createInitializeResult();
    expect(result.capabilities.semanticTokensProvider).toMatchObject({
      legend: {
        tokenTypes: expect.arrayContaining(['type', 'variable', 'property', 'function', 'macro']),
        tokenModifiers: [],
      },
      full: true,
    });
  });
});
