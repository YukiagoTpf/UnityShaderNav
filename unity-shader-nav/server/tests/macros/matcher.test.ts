import { describe, it, expect } from 'vitest';
import type Parser from 'web-tree-sitter';
import { parseHlsl } from '../../src/parser/hlsl/parser';
import { MacroPatternTable } from '../../src/macros';
import { matchDeclarationCall, matchPragmaLine, scanPragmaLines } from '../../src/macros/matcher';

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

describe('matcher: #pragma vertex', () => {
  it('returns target identifier and range', () => {
    const table = new MacroPatternTable();
    const line = '      #pragma vertex vert';
    const match = matchPragmaLine(line, 5, table);
    expect(match?.capturedName).toBe('vert');
    expect(match?.nameRange.start.line).toBe(5);
    expect(line.slice(match!.nameRange.start.character, match!.nameRange.end.character)).toBe('vert');
  });

  it('returns null for unrecognized pragma', () => {
    const table = new MacroPatternTable();
    expect(matchPragmaLine('#pragma multi_compile _ FOG', 0, table)).toBeNull();
  });
});

describe('matcher: pragma scanner', () => {
  it('ignores pragmas inside same-line block comments', () => {
    const table = new MacroPatternTable();
    const refs = scanPragmaLines('/* #pragma vertex Disabled */\n#pragma vertex vert', table);

    expect(refs.map((ref) => ref.capturedName)).toEqual(['vert']);
  });

  it('carries block-comment state across lines', () => {
    const table = new MacroPatternTable();
    const refs = scanPragmaLines([
      '/*',
      '#pragma vertex Disabled',
      '*/',
      '#pragma fragment frag',
    ].join('\n'), table);

    expect(refs.map((ref) => ref.capturedName)).toEqual(['frag']);
  });
});
