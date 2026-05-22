import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHlsl } from '../../../src/parser/hlsl/parser';
import { collect } from '../../../src/parser/hlsl/collector';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');

describe('collector: functions', () => {
  it('collects all top-level function declarations', async () => {
    const text = fixture('functions.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///test/functions.hlsl', 0);

    const fns = result.symbols.filter((s) => s.kind === 'function');
    expect(fns.map((f) => f.name).sort()).toEqual(['add', 'mul3', 'noReturn']);

    const add = fns.find((f) => f.name === 'add')!;
    expect(add.declaredType).toBeUndefined();
    expect((add as any).returnType).toBe('float4');
    expect((add as any).parameters.map((p: any) => p.name)).toEqual(['a', 'b']);
    expect((add as any).parameters.map((p: any) => p.type)).toEqual(['float4', 'float4']);
  });
});

describe('collector: struct', () => {
  it('collects struct name and its members with parentType + declaredType', async () => {
    const text = fixture('structs.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///test/structs.hlsl', 0);

    const structs = result.symbols.filter((s) => s.kind === 'struct').map((s) => s.name);
    expect(structs.sort()).toEqual(['Attributes', 'Varyings']);

    const members = result.symbols.filter((s) => s.kind === 'structMember');
    const attMembers = members.filter((m) => m.parentType === 'Attributes');
    expect(attMembers.map((m) => m.name).sort()).toEqual(['normalOS', 'positionOS', 'uv']);
    expect(attMembers.find((m) => m.name === 'positionOS')!.declaredType).toBe('float4');
  });
});

describe('collector: cbuffer', () => {
  it('collects cbuffer as both cbuffer and its globals', async () => {
    const text = fixture('cbuffer.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///test/cbuffer.hlsl', 0);

    const cbufs = result.symbols.filter((s) => s.kind === 'cbuffer').map((s) => s.name);
    expect(cbufs).toEqual(['UnityPerMaterial']);

    const vars = result.symbols.filter((s) => s.kind === 'variable').map((v) => v.name);
    expect(vars.sort()).toEqual(['_Color', '_MainTex_ST', '_Roughness']);
  });
});
