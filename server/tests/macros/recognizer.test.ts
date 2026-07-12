import { describe, expect, it, vi } from 'vitest';
import type Parser from 'web-tree-sitter';
import {
  MacroPatternRecognizer,
  builtinDeclarationMacroLexicalRole,
  macroPatternIdentity,
} from '../../src/macros';
import { parseHlsl } from '../../src/parser/hlsl/parser';

describe('MacroPatternRecognizer', () => {
  it('recognizes built-in and user declaration macros as domain matches', async () => {
    const recognizer = new MacroPatternRecognizer([
      { pattern: 'MY_PROP(_, $name)', kind: 'variable' },
    ]);
    const calls = await parseCalls([
      'TEXTURE2D(_MainTex);',
      'MY_PROP(float4, _Tint);',
    ].join('\n'));

    const matches = calls.map((call) => recognizer.matchDeclarationCall(call));
    expect(matches).toEqual([
      expect.objectContaining({
        symbolKind: 'variable',
        capturedName: '_MainTex',
      }),
      expect.objectContaining({
        symbolKind: 'variable',
        capturedName: '_Tint',
      }),
    ]);
    expect(matches[0]?.nameRange).toEqual({
      start: { line: 0, character: 10 },
      end: { line: 0, character: 18 },
    });
    expect(matches[1]?.nameRange).toEqual({
      start: { line: 1, character: 16 },
      end: { line: 1, character: 21 },
    });
  });

  it('reports and skips invalid user patterns without disturbing built-ins', async () => {
    const reportDiagnostic = vi.fn();
    const recognizer = new MacroPatternRecognizer([
      { pattern: 'BROKEN $name', kind: 'variable' },
      { pattern: 'NO_CAPTURE(_)', kind: 'variable' },
    ], { reportDiagnostic });
    const [call] = await parseCalls('TEXTURE2D(_MainTex);');

    expect(recognizer.matchDeclarationCall(call)?.capturedName).toBe('_MainTex');
    expect(reportDiagnostic).toHaveBeenCalledTimes(2);
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining('Skipping invalid unityShaderNav.declarationMacros entry'),
    );
  });

  it('recognizes every supported pragma reference and returns exact ranges', () => {
    const text = [
      '#pragma vertex vert',
      '  #pragma fragment frag',
      '#pragma geometry geom',
      '#pragma hull hullMain',
      '#pragma domain domainMain',
      '#pragma surface surf Standard',
      '#pragma kernel CSMain',
      '#pragma multi_compile _ FOG',
    ].join('\n');

    const matches = new MacroPatternRecognizer().scanReferencePatterns(text);

    expect(matches.map((match) => match.capturedName)).toEqual([
      'vert',
      'frag',
      'geom',
      'hullMain',
      'domainMain',
      'surf',
      'CSMain',
    ]);
    for (const match of matches) {
      const line = text.split('\n')[match.nameRange.start.line];
      expect(line.slice(
        match.nameRange.start.character,
        match.nameRange.end.character,
      )).toBe(match.capturedName);
    }
  });

  it('ignores reference-looking pragmas in line and block comments', () => {
    const matches = new MacroPatternRecognizer().scanReferencePatterns([
      '// #pragma vertex DisabledLine',
      '/* #pragma vertex DisabledInline */',
      '/*',
      '#pragma fragment DisabledBlock',
      '*/',
      '#pragma vertex vert',
    ].join('\n'));

    expect(matches.map((match) => match.capturedName)).toEqual(['vert']);
  });

  it('owns structural sentinel and built-in lexical facts', () => {
    const recognizer = new MacroPatternRecognizer([
      { pattern: 'CUSTOM_TEX($name)', kind: 'variable' },
    ]);

    expect(recognizer.isStructuralSentinel('CBUFFER_END')).toBe(true);
    expect(recognizer.isStructuralSentinel('CUSTOM_TEX')).toBe(false);
    expect(builtinDeclarationMacroLexicalRole('TEXTURE2D')).toBe('macro');
    expect(builtinDeclarationMacroLexicalRole('CBUFFER_START')).toBe('macro');
    expect(builtinDeclarationMacroLexicalRole('CUSTOM_TEX')).toBeUndefined();
  });

  it('provides stable content identity without exposing compiled patterns', () => {
    const first = macroPatternIdentity([
      { pattern: 'A($name)', kind: 'variable' },
      { pattern: 'B($name)', kind: 'cbuffer' },
    ]);
    const reordered = macroPatternIdentity([
      { pattern: 'B($name)', kind: 'cbuffer' },
      { pattern: 'A($name)', kind: 'variable' },
    ]);
    const changed = macroPatternIdentity([
      { pattern: 'A($name)', kind: 'variable' },
    ]);

    expect(first).toMatch(/^[a-f0-9]{40}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});

async function parseCalls(source: string): Promise<Parser.SyntaxNode[]> {
  const tree = await parseHlsl(source);
  const calls: Parser.SyntaxNode[] = [];
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'call_expression') calls.push(node);
    for (let index = 0; index < node.namedChildCount; index++) {
      const child = node.namedChild(index);
      if (child) walk(child);
    }
  };
  walk(tree.rootNode);
  return calls;
}
