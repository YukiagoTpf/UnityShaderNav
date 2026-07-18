import { describe, expect, it, vi } from 'vitest';
import type Parser from 'web-tree-sitter';
import {
  MacroPatternRecognizer,
  builtinDeclarationMacroLexicalRole,
  macroPatternIdentity,
} from '../../src/macros';
import { BUILTIN_DECLARATION_MACROS } from '../../src/macros/builtin';
import { parseHlsl } from '../../src/parser/hlsl/parser';

describe('MacroPatternRecognizer', () => {
  it.each([
    ['TEXTURE2D', 'Texture2D'],
    ['TEXTURE2D_HALF', 'Texture2D'],
    ['TEXTURE2D_FLOAT', 'Texture2D'],
    ['TEXTURE2D_ARRAY', 'Texture2DArray'],
    ['TEXTURE2D_ARRAY_HALF', 'Texture2DArray'],
    ['TEXTURE2D_ARRAY_FLOAT', 'Texture2DArray'],
    ['TEXTURE3D', 'Texture3D'],
    ['TEXTURE3D_HALF', 'Texture3D'],
    ['TEXTURE3D_FLOAT', 'Texture3D'],
    ['TEXTURECUBE', 'TextureCube'],
    ['TEXTURECUBE_HALF', 'TextureCube'],
    ['TEXTURECUBE_FLOAT', 'TextureCube'],
    ['TEXTURECUBE_ARRAY', 'TextureCubeArray'],
    ['TEXTURECUBE_ARRAY_HALF', 'TextureCubeArray'],
    ['TEXTURECUBE_ARRAY_FLOAT', 'TextureCubeArray'],
    ['TEXTURE2D_SHADOW', 'Texture2D'],
    ['TEXTURE2D_ARRAY_SHADOW', 'Texture2DArray'],
    ['TEXTURECUBE_SHADOW', 'TextureCube'],
    ['TEXTURECUBE_ARRAY_SHADOW', 'TextureCubeArray'],
    ['SAMPLER', 'SamplerState'],
    ['SAMPLER_CMP', 'SamplerComparisonState'],
  ])('returns canonical receiver type for %s declarations', async (head, declaredType) => {
    const recognizer = new MacroPatternRecognizer();
    const [call] = await parseCalls(`${head}(_Resource);`);

    expect(recognizer.matchDeclarationCall(call)).toMatchObject({
      symbolKind: 'variable',
      capturedName: '_Resource',
      declaredType,
    });
  });

  it('does not claim one canonical type for platform-dependent TEXTURE2D_X', async () => {
    const [call] = await parseCalls('TEXTURE2D_X(_CameraTexture);');

    expect(new MacroPatternRecognizer().matchDeclarationCall(call)?.declaredType).toBeUndefined();
  });

  it.each([
    ['TYPED_TEXTURE2D(float4, _Typed2D)', '_Typed2D', 'Texture2D<float4>'],
    [
      'TYPED_TEXTURE2D(Rendering::Pixel, _Qualified2D)',
      '_Qualified2D',
      'Texture2D<Rendering::Pixel>',
    ],
    ['TYPED_TEXTURE2D_ARRAY(MyPixel, _TypedArray)', '_TypedArray', 'Texture2DArray<MyPixel>'],
    ['TYPED_TEXTURE3D(uint4, _Typed3D)', '_Typed3D', 'Texture3D<uint4>'],
    ['RW_TEXTURE2D(float4, _Rw2D)', '_Rw2D', 'RWTexture2D<float4>'],
    ['RW_TEXTURE2D_ARRAY(int4, _RwArray)', '_RwArray', 'RWTexture2DArray<int4>'],
    ['RW_TEXTURE3D(uint, _Rw3D)', '_Rw3D', 'RWTexture3D<uint>'],
    ['UNITY_DEFINE_INSTANCED_PROP(half4, _Tint)', '_Tint', 'half4'],
    ['UNITY_DOTS_INSTANCED_PROP(SurfaceData, _Surface)', '_Surface', 'SurfaceData'],
  ])('derives canonical type from declaration argument for %s', async (
    source,
    capturedName,
    declaredType,
  ) => {
    const [call] = await parseCalls(`${source};`);

    expect(new MacroPatternRecognizer().matchDeclarationCall(call)).toMatchObject({
      symbolKind: 'variable',
      capturedName,
      declaredType,
    });
  });

  it('ignores comments around a declaration macro type argument', async () => {
    const [call] = await parseCalls(
      'TYPED_TEXTURE2D(/* precision */ float4, _CommentedTexture);',
    );

    expect(new MacroPatternRecognizer().matchDeclarationCall(call)).toMatchObject({
      symbolKind: 'variable',
      capturedName: '_CommentedTexture',
      declaredType: 'Texture2D<float4>',
    });
  });

  it('normalizes comments and multiline layout inside a nested generic type', async () => {
    const [call] = await parseCalls([
      'TYPED_TEXTURE2D(',
      '  vector<',
      '    float, /* components */',
      '    4',
      '  >,',
      '  _NestedTexture',
      ');',
    ].join('\n'));

    expect(new MacroPatternRecognizer().matchDeclarationCall(call)).toMatchObject({
      capturedName: '_NestedTexture',
      declaredType: 'Texture2D<vector<float, 4>>',
    });
  });

  it('keeps an empty typed-macro declaration indexed without fabricating a type', async () => {
    const [call] = await parseCalls('TYPED_TEXTURE2D(, _IncompleteTexture);');

    const match = new MacroPatternRecognizer().matchDeclarationCall(call);
    expect(match).toMatchObject({
      symbolKind: 'variable',
      capturedName: '_IncompleteTexture',
    });
    expect(match?.declaredType).toBeUndefined();
  });

  it('keeps an expression-typed macro declaration indexed without fabricating a type', async () => {
    const [call] = await parseCalls('TYPED_TEXTURE2D(1 + 2, _InvalidTexture);');

    const match = new MacroPatternRecognizer().matchDeclarationCall(call);
    expect(match).toMatchObject({
      symbolKind: 'variable',
      capturedName: '_InvalidTexture',
    });
    expect(match?.declaredType).toBeUndefined();
  });

  it('rejects a generic type with a missing trailing argument', async () => {
    const [call] = await parseCalls(
      'TYPED_TEXTURE2D(vector<float, 4,>, _MalformedTexture);',
    );

    const match = new MacroPatternRecognizer().matchDeclarationCall(call);
    expect(match).toMatchObject({ capturedName: '_MalformedTexture' });
    expect(match?.declaredType).toBeUndefined();
  });

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
    expect(matches[1]?.declaredType).toBeUndefined();
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

  it('includes canonical declared type metadata in the content identity', () => {
    const texture = BUILTIN_DECLARATION_MACROS.find(
      (macro) => macro.pattern === 'TEXTURE2D($name)',
    )!;
    const originalType = texture.declaredType;
    const before = macroPatternIdentity([]);

    try {
      texture.declaredType = 'ChangedTextureType';
      expect(macroPatternIdentity([])).not.toBe(before);
    } finally {
      texture.declaredType = originalType;
    }
  });

  it('includes declared type recipes in the content identity', () => {
    const typedTexture = BUILTIN_DECLARATION_MACROS.find(
      (macro) => macro.pattern === 'TYPED_TEXTURE2D(_, $name)',
    )!;
    const originalRecipe = typedTexture.declaredTypeRecipe;
    const before = macroPatternIdentity([]);

    try {
      typedTexture.declaredTypeRecipe = {
        kind: 'generic',
        baseType: 'ChangedTextureType',
        argumentIndex: 0,
      };
      expect(macroPatternIdentity([])).not.toBe(before);
    } finally {
      typedTexture.declaredTypeRecipe = originalRecipe;
    }
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
