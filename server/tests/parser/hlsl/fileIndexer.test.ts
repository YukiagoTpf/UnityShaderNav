import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  indexFile,
  indexFileWithTemporaryTrees,
} from '../../../src/parser/hlsl/fileIndexer';
import {
  createHlslParser,
  type ReusableHlslParser,
} from '../../../src/parser/hlsl/parser';
import { scanProperties } from '../../../src/parser/shaderlab/propertiesScanner';
import { MacroPatternRecognizer } from '../../../src/macros';
import { analyzeDocument } from '../../../src/analysis';

describe('fileIndexer: pure .hlsl', () => {
  it('treats whole file as one HLSL block', async () => {
    const text = `float4 add(float4 a, float4 b) { return a + b; }`;
    const idx = await indexFile('file:///t/x.hlsl', text);
    expect(idx.symbols.find((s) => s.name === 'add')).toBeDefined();
  });

  it('records #include directives as references with context=include', async () => {
    const text = `#include "Common.hlsl"\nfloat4 x() { return 0; }`;
    const idx = await indexFile('file:///t/a.hlsl', text);
    const includeRef = idx.references.find((r) => r.context === 'include');

    expect(includeRef?.name).toBe('Common.hlsl');
  });

  it('records #define directives as macro symbols', async () => {
    const text = '#define FOO 1\nfloat4 main(){return 0;}';
    const idx = await indexFile('file:///t/d.hlsl', text);
    const foo = idx.symbols.find((s) => s.name === 'FOO');

    expect(foo?.kind).toBe('macro');
    expect(foo?.location.range.start).toEqual({ line: 0, character: 8 });
  });

  it('ignores pragma references inside block comments', async () => {
    const text = [
      '/* #pragma vertex Disabled */',
      '/*',
      '#pragma fragment AlsoDisabled',
      '*/',
      '#pragma vertex vert',
      'void vert() {}',
    ].join('\n');
    const idx = await indexFile('file:///t/pragmas.hlsl', text, new MacroPatternRecognizer());

    const pragmaRefs = idx.references.filter((r) => r.context === 'pragma');
    expect(pragmaRefs.map((r) => r.name)).toEqual(['vert']);
    expect(pragmaRefs[0]?.location.range.start).toEqual({ line: 4, character: 15 });
  });
});

describe('fileIndexer: .shader multi-pass', () => {
  it('releases every temporary full-parse tree and its parser', async () => {
    const parser = await createHlslParser();
    const treeDeletes: Array<ReturnType<typeof vi.fn>> = [];
    const parserDelete = vi.fn(parser.delete.bind(parser));
    const trackedParser: ReusableHlslParser = {
      parseStabilized(text, oldTree) {
        const tree = parser.parseStabilized(text, oldTree);
        const deleteTree = vi.fn(tree.delete.bind(tree));
        tree.delete = deleteTree;
        treeDeletes.push(deleteTree);
        return tree;
      },
      delete: parserDelete,
    };
    const text = shaderWithTwoBlocks('FirstDiskBlock', 'SecondDiskBlock');

    const index = await indexFileWithTemporaryTrees(
      'file:///t/TemporaryTrees.shader',
      text,
      undefined,
      undefined,
      async () => trackedParser,
    );

    expect(index.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining([
      'FirstDiskBlock',
      'SecondDiskBlock',
    ]));
    expect(treeDeletes).toHaveLength(2);
    expect(treeDeletes.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(parserDelete).toHaveBeenCalledTimes(1);
  });

  it('flattens symbols from all HLSL blocks into one file index', async () => {
    const text = readFileSync(
      join(__dirname, '../shaderlab/fixtures/multi-pass.shader'),
      'utf8',
    );
    const idx = await indexFile('file:///t/x.shader', text);
    const verts = idx.symbols.filter((s) => s.kind === 'function' && s.name === 'vert');
    // multi-pass fixture has 2 `void vert() {}` definitions
    expect(verts).toHaveLength(2);
    // 行号必须落在原 .shader 文件的对应行（不应该是 0/1，应该是 HLSLPROGRAM 后一两行）
    expect(verts[0].location.range.start.line).toBeGreaterThan(3);
    expect(verts[1].location.range.start.line).toBeGreaterThan(verts[0].location.range.start.line);
  });

  it('attaches ShaderLab structure for .shader files', async () => {
    const text = readFileSync(
      join(__dirname, '../shaderlab/fixtures/multi-pass.shader'),
      'utf8',
    );
    const analysis = analyzeDocument('file:///t/x.shader', text, 'index')!;
    const idx = await indexFile('file:///t/x.shader', text, undefined, analysis);

    expect(idx.structure?.shaders).toBeDefined();
    expect(idx.structure?.shaders[0]?.children[0]?.children.length).toBeGreaterThan(0);
    expect(idx.structure).toBe(analysis.structure);
  });

  it('publishes only real structure from the exact analyzed source', async () => {
    const text = [
      'Shader "T/Comments" {',
      '  SubShader {',
      '    /*',
      '    Pass { Name "FakeCommentedPass" }',
      '    */',
      '    Pass { Name "RealPass" }',
      '  }',
      '}',
    ].join('\n');
    const analysis = analyzeDocument('file:///t/comments.shader', text, 'full')!;
    const idx = await indexFile('file:///t/comments.shader', text, undefined, analysis);

    expect(idx.structure).toBe(analysis.structure);
    expect(idx.structure?.shaders[0].children[0].children)
      .toEqual([expect.objectContaining({ name: 'RealPass', headerLine: 5 })]);
  });

  it('records #define directives inside shader HLSL blocks with original line offsets', async () => {
    const text = [
      'Shader "T" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      #define SHADER_MACRO 1',
      '      float4 main(){return 0;}',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const idx = await indexFile('file:///t/macro.shader', text);
    const macro = idx.symbols.find((s) => s.name === 'SHADER_MACRO');

    expect(macro?.kind).toBe('macro');
    expect(macro?.location.range.start).toEqual({ line: 4, character: 14 });
  });

  it('ignores pragma references inside block comments in shader HLSL blocks', async () => {
    const text = [
      'Shader "T" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      /* #pragma vertex Disabled */',
      '      /*',
      '      #pragma fragment AlsoDisabled',
      '      */',
      '      #pragma vertex vert',
      '      void vert() {}',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const idx = await indexFile('file:///t/pragmas.shader', text, new MacroPatternRecognizer());
    const pragmaRefs = idx.references.filter((r) => r.context === 'pragma');

    expect(pragmaRefs.map((r) => r.name)).toEqual(['vert']);
    expect(pragmaRefs[0]?.location.range.start).toEqual({ line: 8, character: 21 });
  });

  it('keeps symbols and references from presentation-only inactive branches', async () => {
    const text = [
      'Shader "T/Inactive" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      #if 0',
      '      float4 InactiveTarget() { return 0; }',
      '      #endif',
      '      float4 ActiveCaller() { return InactiveTarget(); }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const idx = await indexFile('file:///t/inactive.shader', text);

    expect(idx.symbols.some((symbol) => symbol.name === 'InactiveTarget')).toBe(true);
    expect(idx.references.some((reference) => (
      reference.name === 'InactiveTarget' && reference.context === 'call'
    ))).toBe(true);
  });
});

function shaderWithTwoBlocks(first: string, second: string): string {
  return [
    'Shader "Tests/TemporaryTrees" {',
    '  HLSLINCLUDE',
    `  float4 ${first}() { return 0; }`,
    '  ENDHLSL',
    '  SubShader { Pass {',
    '    HLSLPROGRAM',
    `    float4 ${second}() { return 0; }`,
    '    ENDHLSL',
    '  } }',
    '}',
  ].join('\n');
}

describe('fileIndexer: .shader Properties attachment', () => {
  it('attaches Properties entries matching scanProperties for a .shader with a Properties block', async () => {
    const text = [
      'Shader "T/Props" {',
      '  Properties {',
      '    _MainTex ("Base Map", 2D) = "white" {}',
      '    _BaseColor ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 _BaseColor;',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const idx = await indexFile('file:///t/props.shader', text);
    const expected = scanProperties(text);

    expect(idx.properties).toBeDefined();
    expect(idx.properties).toHaveLength(expected.length);
    expect(idx.properties).toEqual(expected);
  });

  it('leaves properties undefined for a .shader without a Properties block', async () => {
    const text = [
      'Shader "T/NoProps" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 _BaseColor;',
      '      void frag() {}',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const idx = await indexFile('file:///t/noprops.shader', text);
    expect(idx.properties).toBeUndefined();
  });

  it('does not run the Properties scanner for non-.shader extensions', async () => {
    // Text that *would* parse as a Properties block if mis-routed to the
    // .shader branch — confirms the scanner is gated by extension.
    const text = [
      'Shader "T/Misrouted" {',
      '  Properties {',
      '    _MainTex ("Base Map", 2D) = "white" {}',
      '  }',
      '}',
    ].join('\n');

    const idx = await indexFile('file:///t/misrouted.hlsl', text);
    expect(idx.properties).toBeUndefined();
  });
});
