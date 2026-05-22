// R1 spike: dump tree-sitter-hlsl node shapes for canonical HLSL fragments.
// Run from unity-shader-nav/: node scripts/probe-hlsl.mjs
import Parser from 'web-tree-sitter';

await Parser.init();
const lang = await Parser.Language.load('./server/grammars/tree-sitter-hlsl.wasm');
const parser = new Parser();
parser.setLanguage(lang);

const samples = {
  fn:      'float4 add(float4 a, float4 b) { return a + b; }',
  voidFn:  'void noReturn() { }',
  struct:  'struct Foo { float3 pos; float2 uv; };',
  cbuffer: 'cbuffer X { float4 _Color; float r; };',
  call:    'float4 main() { return add(float4(0,0,0,1), float4(1,1,1,1)); }',
  member:  'void f(Varyings v) { float2 u = v.uv; }',
  local:   'float4 compute(float k) { float s = k * 2; return float4(s,s,s,1); }',
  forLoop: 'void f() { for (int i = 0; i < 10; ++i) { } }',
  nestedStruct: 'struct Inner { float3 normal; }; struct Outer { Inner inner; float4 position; };',
};

for (const [k, code] of Object.entries(samples)) {
  const tree = parser.parse(code);
  console.log(`=== ${k} ===`);
  console.log(code);
  console.log(tree.rootNode.toString());
  console.log('');
}
