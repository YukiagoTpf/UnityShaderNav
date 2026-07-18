import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexFile } from '../../src/parser/hlsl';
import { MacroPatternRecognizer } from '../../src/macros';
import { analyzeCursor } from '../../src/parser/lexical/cursor';
import { resolveDefinition } from '../../src/index/symbolResolver';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('integration: macros end-to-end', () => {
  it('TEXTURE2D(_MainTex) registers _MainTex as variable', async () => {
    const idx = await indexFile(
      'file:///t/textures.hlsl',
      fixture('textures.hlsl'),
      new MacroPatternRecognizer(),
    );
    const main = idx.symbols.find((s) => s.name === '_MainTex');
    expect(main).toBeDefined();
    expect(main?.kind).toBe('variable');
  });

  it.each([
    ['TEXTURE2D_HALF(_HalfTex)', '_HalfTex', 'Texture2D'],
    ['TYPED_TEXTURE2D(float4, _TypedTex)', '_TypedTex', 'Texture2D<float4>'],
    ['RW_TEXTURE2D(uint4, _WritableTex)', '_WritableTex', 'RWTexture2D<uint4>'],
  ])('indexes canonical type from %s', async (declaration, name, declaredType) => {
    const idx = await indexFile(
      'file:///t/typed-textures.hlsl',
      `${declaration};`,
      new MacroPatternRecognizer(),
    );

    expect(idx.symbols.find((symbol) => symbol.name === name)).toMatchObject({
      kind: 'variable',
      declaredType,
    });
  });

  it.each([
    ['TEXTURE2D_X_HALF(_XHalf)', '_XHalf', undefined],
    ['TEXTURE2D_X_FLOAT(_XFloat)', '_XFloat', undefined],
    ['RW_TEXTURE2D_X(float4, _WritableX)', '_WritableX', undefined],
    [
      'UNITY_DOTS_INSTANCED_PROP_OVERRIDE_DISABLED(float4, _Disabled)',
      '_Disabled',
      'float4',
    ],
    [
      'UNITY_DOTS_INSTANCED_PROP_OVERRIDE_SUPPORTED(SurfaceData, _Supported)',
      '_Supported',
      'SurfaceData',
    ],
    [
      'UNITY_DOTS_INSTANCED_PROP_OVERRIDE_REQUIRED(vector<float, 4>, _Required)',
      '_Required',
      'vector<float, 4>',
    ],
  ])('indexes the official declaration form %s', async (
    declaration,
    name,
    declaredType,
  ) => {
    const idx = await indexFile(
      'file:///t/official-declaration-macros.hlsl',
      `${declaration};`,
      new MacroPatternRecognizer(),
    );

    const symbol = idx.symbols.find((candidate) => candidate.name === name);
    expect(symbol).toMatchObject({ kind: 'variable' });
    expect(symbol?.declaredType).toBe(declaredType);
  });

  it.each([
    ['TYPED_TEXTURE2D(, _Incomplete)', '_Incomplete'],
    ['TYPED_TEXTURE2D(1 + 2, _Invalid)', '_Invalid'],
  ])('indexes %s without a fabricated receiver type', async (declaration, name) => {
    const idx = await indexFile(
      'file:///t/invalid-declaration-types.hlsl',
      `${declaration};`,
      new MacroPatternRecognizer(),
    );

    const symbol = idx.symbols.find((candidate) => candidate.name === name);
    expect(symbol).toMatchObject({ kind: 'variable' });
    expect(symbol?.declaredType).toBeUndefined();
  });

  it('#pragma vertex vert registers vert as pragma reference', async () => {
    const idx = await indexFile(
      'file:///t/pragmas.shader',
      fixture('pragmas.shader'),
      new MacroPatternRecognizer(),
    );
    const vertRef = idx.references.find((r) => r.name === 'vert' && r.context === 'pragma');
    expect(vertRef).toBeDefined();
  });

  it('does not register pragma references inside shader block comments', async () => {
    const uri = 'file:///t/commented-pragmas.shader';
    const text = [
      'Shader "T/CommentedPragma" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      /*',
      '      #pragma vertex Disabled',
      '      */',
      '      #pragma vertex vert',
      '      void Disabled() {}',
      '      void vert() {}',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const idx = await indexFile(uri, text, new MacroPatternRecognizer());
    const pragmaRefs = idx.references.filter((r) => r.context === 'pragma');

    expect(pragmaRefs.map((r) => r.name)).toEqual(['vert']);
  });

  it('CBUFFER_START(UnityPerMaterial) registers UnityPerMaterial as cbuffer', async () => {
    const idx = await indexFile(
      'file:///t/cb.hlsl',
      fixture('cbuffer-macro.hlsl'),
      new MacroPatternRecognizer(),
    );
    const cb = idx.symbols.find((s) => s.name === 'UnityPerMaterial');
    expect(cb?.kind).toBe('cbuffer');
  });

  it('filters structural cbuffer sentinel references while preserving cbuffer declaration', async () => {
    const idx = await indexFile(
      'file:///t/cb.hlsl',
      fixture('cbuffer-macro.hlsl'),
      new MacroPatternRecognizer(),
    );

    expect(idx.symbols.find((s) => s.name === 'UnityPerMaterial')?.kind).toBe('cbuffer');
    expect(idx.references.some((r) => r.name === 'CBUFFER_END')).toBe(false);
  });

  it('filters structural instancing buffer sentinel calls and arguments', async () => {
    const idx = await indexFile(
      'file:///t/instanced-prop.hlsl',
      fixture('instanced-prop.hlsl'),
      new MacroPatternRecognizer(),
    );

    expect(idx.symbols.find((s) => s.name === '_BaseColor')).toMatchObject({
      kind: 'variable',
      declaredType: 'float4',
    });
    expect(idx.references.map((r) => `${r.name}:${r.context}`).sort()).toEqual([]);
  });

  it.each([
    ['UNITY_INSTANCING_BUFFER_START', 'Props', 'UNITY_INSTANCING_BUFFER_END(Props)'],
    ['UNITY_INSTANCING_CBUFFER_SCOPE_BEGIN', 'UnityDrawCallInfo', 'UNITY_INSTANCING_CBUFFER_SCOPE_END'],
    ['UNITY_DOTS_INSTANCING_START', 'MaterialMetadata', 'UNITY_DOTS_INSTANCING_END(MaterialMetadata)'],
  ])('indexes %s declarations without fabricating END symbols', async (
    start,
    name,
    end,
  ) => {
    const text = [`${start}(${name})`, end].join('\n');
    const idx = await indexFile(
      'file:///t/instancing-buffers.hlsl',
      text,
      new MacroPatternRecognizer(),
    );

    expect(idx.symbols.filter((symbol) => symbol.kind === 'cbuffer').map(
      (symbol) => symbol.name,
    )).toEqual([name]);
    expect(idx.references).toEqual([]);
  });

  it('#pragma kernel CSMain registers CSMain as pragma reference in .compute files', async () => {
    const text = [
      '#pragma kernel CSMain',
      '[numthreads(8, 8, 1)]',
      'void CSMain(uint3 id : SV_DispatchThreadID) {}',
    ].join('\n');
    const idx = await indexFile(
      'file:///t/main.compute',
      text,
      new MacroPatternRecognizer(),
    );
    const kernelRef = idx.references.find((r) => r.name === 'CSMain' && r.context === 'pragma');
    expect(kernelRef).toBeDefined();
  });

  it('resolves F12 from #pragma kernel CSMain to the CSMain function in .compute files', async () => {
    const uri = 'file:///t/main.compute';
    const text = [
      '#pragma kernel CSMain',
      '[numthreads(8, 8, 1)]',
      'void CSMain(uint3 id : SV_DispatchThreadID) {}',
    ].join('\n');

    const idx = await indexFile(uri, text, new MacroPatternRecognizer());
    const pos = { line: 0, character: 17 };
    const word = analyzeCursor(text, pos, 'hlsl', uri).word;
    expect(word?.text).toBe('CSMain');

    const links = resolveDefinition(idx, word!.text, pos);
    expect(links).toHaveLength(1);
    expect(links[0].targetUri).toBe(uri);
    expect(links[0].targetRange.start.line).toBe(2);
  });
});
