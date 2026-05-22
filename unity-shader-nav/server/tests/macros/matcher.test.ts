import { describe, it, expect } from 'vitest';
import type Parser from 'web-tree-sitter';
import { parseHlsl } from '../../src/parser/hlsl/parser';
import { MacroPatternTable } from '../../src/macros';
import { matchDeclarationCall } from '../../src/macros/matcher';

describe('matcher: TEXTURE2D / SAMPLER', () => {
  it('extracts _MainTex from TEXTURE2D call', async () => {
    const tree = await parseHlsl('TEXTURE2D(_MainTex);');
    const table = new MacroPatternTable();
    const calls: Parser.SyntaxNode[] = [];
    const walk = (n: Parser.SyntaxNode) => {
      if (n.type === 'call_expression') calls.push(n);
      for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i)!);
    };
    walk(tree.rootNode);

    expect(calls).toHaveLength(1);
    const match = matchDeclarationCall(calls[0], table);
    expect(match?.symbolKind).toBe('variable');
    expect(match?.capturedName).toBe('_MainTex');
  });
});
