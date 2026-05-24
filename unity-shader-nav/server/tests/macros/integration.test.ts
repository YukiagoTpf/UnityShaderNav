import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexFile } from '../../src/parser/hlsl';
import { MacroPatternTable } from '../../src/macros';
import { wordAt } from '../../src/index/wordAt';
import { resolveDefinition } from '../../src/index/symbolResolver';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('integration: macros end-to-end', () => {
  it('TEXTURE2D(_MainTex) registers _MainTex as variable', async () => {
    const idx = await indexFile(
      'file:///t/textures.hlsl',
      fixture('textures.hlsl'),
      new MacroPatternTable(),
    );
    const main = idx.symbols.find((s) => s.name === '_MainTex');
    expect(main).toBeDefined();
    expect(main?.kind).toBe('variable');
  });

  it('#pragma vertex vert registers vert as pragma reference', async () => {
    const idx = await indexFile(
      'file:///t/pragmas.shader',
      fixture('pragmas.shader'),
      new MacroPatternTable(),
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

    const idx = await indexFile(uri, text, new MacroPatternTable());
    const pragmaRefs = idx.references.filter((r) => r.context === 'pragma');

    expect(pragmaRefs.map((r) => r.name)).toEqual(['vert']);
  });

  it('CBUFFER_START(UnityPerMaterial) registers UnityPerMaterial as cbuffer', async () => {
    const idx = await indexFile(
      'file:///t/cb.hlsl',
      fixture('cbuffer-macro.hlsl'),
      new MacroPatternTable(),
    );
    const cb = idx.symbols.find((s) => s.name === 'UnityPerMaterial');
    expect(cb?.kind).toBe('cbuffer');
  });

  it('#pragma kernel CSMain registers CSMain as pragma reference in .compute files', async () => {
    const text = [
      '#pragma kernel CSMain',
      '[numthreads(8, 8, 1)]',
      'void CSMain(uint3 id : SV_DispatchThreadID) {}',
    ].join('\n');
    const idx = await indexFile('file:///t/main.compute', text, new MacroPatternTable());
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

    const idx = await indexFile(uri, text, new MacroPatternTable());
    const pos = { line: 0, character: 17 };
    const word = wordAt(text, pos);
    expect(word?.text).toBe('CSMain');

    const links = resolveDefinition(idx, word!.text, pos);
    expect(links).toHaveLength(1);
    expect(links[0].targetUri).toBe(uri);
    expect(links[0].targetRange.start.line).toBe(2);
  });
});
