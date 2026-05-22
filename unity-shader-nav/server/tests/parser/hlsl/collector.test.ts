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

describe('collector: locals & params', () => {
  it('collects locals with scope = function name and scopeRange spanning body', async () => {
    const text = fixture('locals-and-params.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/loc.hlsl', 0);

    const locals = result.symbols.filter((s) => s.kind === 'localVariable');
    expect(locals.map((l) => l.name).sort()).toEqual(['result', 'scale']);
    expect(locals.every((l) => l.scope === 'compute')).toBe(true);
    expect(locals[0].scopeRange).toBeDefined();
  });
});

describe('collector: shadowing', () => {
  it('keeps both i declarations as separate SymbolEntry', async () => {
    const text = fixture('shadowing-loop.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/shadow.hlsl', 0);

    const is = result.symbols.filter((s) => s.kind === 'localVariable' && s.name === 'i');
    expect(is).toHaveLength(2);
    expect(is[0].location.range.start.line).toBeLessThan(is[1].location.range.start.line);
  });
});

describe('collector: nested struct metadata', () => {
  it('records Outer.inner as structMember with declaredType=Inner', async () => {
    const text = fixture('nested-struct.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/n.hlsl', 0);

    const innerMember = result.symbols.find(
      (s) => s.kind === 'structMember' && s.parentType === 'Outer' && s.name === 'inner',
    );
    expect(innerMember).toBeDefined();
    expect(innerMember!.declaredType).toBe('Inner');

    const makeFn = result.symbols.find((s) => s.kind === 'function' && s.name === 'Make') as any;
    expect(makeFn.returnType).toBe('Outer');
  });
});

describe('collector: references', () => {
  it('records function calls as references with context=call', async () => {
    const text = `
      float4 add(float4 a, float4 b) { return a + b; }
      float4 main() { return add(float4(0,0,0,1), float4(1,1,1,1)); }
    `;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/refs.hlsl', 0);

    const refs = result.references.filter((r) => r.name === 'add');
    expect(refs).toHaveLength(1);
    expect(refs[0].context).toBe('call');
  });

  it('records member accesses with context=member', async () => {
    const text = `void f(Varyings v) { float2 x = v.uv; }`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/m.hlsl', 0);
    const uv = result.references.filter((r) => r.name === 'uv' && r.context === 'member');
    expect(uv).toHaveLength(1);
  });
});
