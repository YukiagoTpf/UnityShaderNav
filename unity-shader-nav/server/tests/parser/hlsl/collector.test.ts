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

describe('collector: global variables', () => {
  it('collects top-level ordinary variable declarations', async () => {
    const text = `float4 _Color; struct Surface { float3 positionWS; }; Surface gSurface;`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///test/globals.hlsl', 0);

    const vars = result.symbols.filter((s) => s.kind === 'variable');
    expect(vars.map((v) => v.name).sort()).toEqual(['_Color', 'gSurface']);
    expect(vars.find((v) => v.name === '_Color')!.declaredType).toBe('float4');
    expect(vars.find((v) => v.name === 'gSurface')!.declaredType).toBe('Surface');
  });

  it('indexes legacy CG variable declarations with declared type metadata', async () => {
    const text = [
      'sampler2D _MainTex;',
      'fixed _Fixed;',
      'fixed2 _Fixed2;',
      'fixed3 _Fixed3;',
      'fixed4 _Color;',
      'half _Cutoff;',
      'half2 _Half2;',
      'half3 _Half3;',
      'half4 _Half4;',
      'float _Float;',
      'float2 _Float2;',
      'float3 _Float3;',
      'float4 _Float4;',
    ].join('\n');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///test/cg-legacy-globals.hlsl', 0);

    const variables = new Map(
      result.symbols
        .filter((symbol) => symbol.kind === 'variable')
        .map((symbol) => [symbol.name, symbol.declaredType]),
    );

    expect(variables).toEqual(new Map([
      ['_MainTex', 'sampler2D'],
      ['_Fixed', 'fixed'],
      ['_Fixed2', 'fixed2'],
      ['_Fixed3', 'fixed3'],
      ['_Color', 'fixed4'],
      ['_Cutoff', 'half'],
      ['_Half2', 'half2'],
      ['_Half3', 'half3'],
      ['_Half4', 'half4'],
      ['_Float', 'float'],
      ['_Float2', 'float2'],
      ['_Float3', 'float3'],
      ['_Float4', 'float4'],
    ]));
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

  it('collects all local declarators and normalizes array declarator names', async () => {
    const text = `float4 f(float4 a) { float x = 1, y = 2; float3 arr[2]; return a; }`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/multi-locals.hlsl', 0);

    const locals = result.symbols.filter((s) => s.kind === 'localVariable');
    expect(locals.map((l) => l.name).sort()).toEqual(['arr', 'x', 'y']);
    expect(locals.find((l) => l.name === 'arr')!.declaredType).toBe('float3');
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

  it('records the receiver identifier for member references', async () => {
    const text = `void f(Varyings v) { float2 x = v.uv; }`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/member-receiver.hlsl', 0);

    const uv = result.references.find((r) => r.name === 'uv' && r.context === 'member');

    expect(uv).toMatchObject({ receiver: 'v' });
  });

  it('records complex receiver expressions for member references', async () => {
    const text = [
      'void f(Surface surface, Light lights[4], int i) {',
      '  float3 c = lights[i].color;',
      '  float r = surface.brdfData.roughness;',
      '}',
    ].join('\n');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/member-receiver-complex.hlsl', 0);

    const color = result.references.find((r) => r.name === 'color' && r.context === 'member');
    const roughness = result.references.find((r) => r.name === 'roughness' && r.context === 'member');

    expect(color).toMatchObject({ receiver: 'lights[i]' });
    expect(roughness).toMatchObject({ receiver: 'surface.brdfData' });
  });

  it('records ordinary identifier use sites without counting declarations', async () => {
    const text = `float4 f(float4 a, float4 b) { float4 c = a + b; return c; }`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/ids.hlsl', 0);

    const ids = result.references.filter((r) => r.context === 'identifier');
    expect(ids.map((r) => r.name).sort()).toEqual(['a', 'b', 'c']);
    expect(ids.filter((r) => r.name === 'f')).toHaveLength(0);
  });

  it('records custom type uses in declarations without counting the type declaration', async () => {
    const text = `struct S { float x; }; S Make(S a) { S b; return a; }`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/type-refs.hlsl', 0);

    const refs = result.references.filter((r) => r.name === 'S' && r.context === 'type');
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.location.range.start.character)).toEqual([23, 30, 37]);
  });

  it('records custom type uses in C-style casts', async () => {
    const text = `struct InputData { float3 positionWS; }; void frag() { InputData inputData; inputData = (InputData)0; }`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/cast-type-refs.hlsl', 0);

    const refs = result.references.filter((r) => r.name === 'InputData' && r.context === 'type');
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.location.range.start.character)).toEqual([55, 89]);
  });

  it('records direct call assignment type inference facts', async () => {
    const text = [
      'struct Surface { float3 positionWS; };',
      'Surface MakeSurface() { Surface s; return s; }',
      'void frag() {',
      '  surface = MakeSurface();',
      '  float3 p = surface.positionWS;',
      '}',
    ].join('\n');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/rhs-inference.hlsl', 0);

    expect(result.typeInferences).toEqual([{
      receiver: 'surface',
      callName: 'MakeSurface',
      assignmentRange: {
        start: { line: 3, character: 2 },
        end: { line: 3, character: 25 },
      },
      scope: 'frag',
      scopeRange: {
        start: { line: 2, character: 12 },
        end: { line: 5, character: 1 },
      },
    }]);
  });
});

describe('collector: declarator variants', () => {
  it('collects all struct members and normalizes struct array member names', async () => {
    const text = `struct S { float a, b; float4 pos[2]; };`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/struct-declarators.hlsl', 0);

    const members = result.symbols.filter((s) => s.kind === 'structMember');
    expect(members.map((m) => m.name).sort()).toEqual(['a', 'b', 'pos']);
    expect(members.find((m) => m.name === 'pos')!.declaredType).toBe('float4');
  });

  it('collects all cbuffer declarators', async () => {
    const text = `cbuffer C { float _A, _B; }`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/cbuffer-declarators.hlsl', 0);

    const variables = result.symbols.filter((s) => s.kind === 'variable');
    expect(variables.map((v) => v.name).sort()).toEqual(['_A', '_B']);
  });
});
