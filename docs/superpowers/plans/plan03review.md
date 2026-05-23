# Plan03 Code Review Report

Review date: 2026-05-22

Scope:
- Plan document: `docs/superpowers/plans/2026-05-22-03-hlsl-symbol-collector.md`
- Confirmed git range: `b89fbe4..9514c23` for isolated Plan03 changes. `a993b98..HEAD` also includes Plan01/Plan02 fix commits and review reports, so this review excludes those earlier fix products except where existing build/package scripts affect Plan03 runtime behavior.
- Product commits reviewed: `bf90337..92616e1`; `9514c23` is the Plan03 progress/documentation commit.
- Reviewed code under `unity-shader-nav/shared/src/symbols.ts`, `unity-shader-nav/server/src/parser/hlsl/`, `unity-shader-nav/server/tests/parser/hlsl/`, and the existing package/build path that must carry the Plan03 WASM grammar.

## Findings

### P1 - Generic identifier references are never collected

References:
- `docs/superpowers/plans/2026-05-22-03-hlsl-symbol-collector.md:5`
- `unity-shader-nav/shared/src/symbols.ts:36`
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:254`
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:284`
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:292`
- `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts:98`
- `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts:118`

Plan03 explicitly requires references for `call/type/member/identifier`, and the shared type includes `ReferenceContext = ... | 'identifier'`. The implementation only handles `call_expression`, `field_expression`, and `type_identifier`; there is no branch for ordinary identifier use sites.

Reproduced with:

```hlsl
float4 f(float4 a, float4 b) {
  float4 c = a + b;
  return c;
}
```

Actual `idx.references`: `[]`.

Expected: identifier references for `a`, `b`, and `c` use sites, with declaration sites excluded. Without this, Find References and later same-file definition filtering cannot work for parameters, locals, and globals unless every use happens to be a call/member/type node. Current tests only cover call and member references, so the missing `identifier` context is unprotected.

Recommended fix:
- Add an `identifier` reference branch after declaration-site filtering and after call/member/type de-duplication.
- Add tests for parameter and local variable uses, including a declaration that must not be double-counted as a reference.

### P1 - Packaged/copied server output cannot load the vendored HLSL WASM grammar

References:
- `unity-shader-nav/server/src/parser/hlsl/parser.ts:20`
- `unity-shader-nav/server/src/parser/hlsl/parser.ts:21`
- `unity-shader-nav/server/src/parser/hlsl/parser.ts:22`
- `unity-shader-nav/scripts/copy-server.mjs:10`
- `unity-shader-nav/scripts/copy-server.mjs:11`
- `unity-shader-nav/scripts/copy-server.mjs:16`
- `unity-shader-nav/scripts/build.mjs:13`
- `unity-shader-nav/client/src/client.ts:11`

`parser.ts` resolves the grammar relative to `__dirname` as `../../../grammars/tree-sitter-hlsl.wasm`. That works from `server/src/parser/hlsl` and `server/out/parser/hlsl`, where it lands on `server/grammars`. But the packaged extension runs the server from `client/out/server/server.js`, and `copy-server.mjs` copies only `server/out` into `client/out/server`; it does not copy `server/grammars`.

Reproduced against the copied server output:

```bash
node -e "const {parseHlsl}=require('./client/out/server/parser/hlsl/parser'); parseHlsl('float f(){return 1;}').catch(e=>{console.error(e.message); process.exit(1);})"
```

Actual error:

```text
ENOENT: no such file or directory, open 'F:\Project\UnityShaderNav\unity-shader-nav\client\out\grammars\tree-sitter-hlsl.wasm'
```

Impact: Plan03 tests pass from the server workspace, but the extension's server copy cannot use `parseHlsl` once the indexer is wired into the LSP runtime.

Recommended fix:
- Copy `server/grammars/tree-sitter-hlsl.wasm` into the runtime package layout, or resolve it from a location guaranteed to exist in both workspace and packaged modes.
- Add a package-layout smoke test that imports the copied server parser/indexer and parses a trivial HLSL snippet.

### P2 - Multiple declarators and array declarators are missed or indexed under the wrong name

References:
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:111`
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:120`
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:196`
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:207`
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:236`
- `unity-shader-nav/server/src/parser/hlsl/collector.ts:249`
- `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts:56`
- `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts:78`

The collector uses `childForFieldName('declarator')`, which returns only one declarator when tree-sitter exposes repeated `declarator` fields. It also only unwraps `init_declarator` for locals, and stores `textOf(fidNode)` for struct members even when the declarator is an `array_declarator`.

Reproduced with:

```hlsl
struct S { float a, b; float4 pos[2]; };
cbuffer C { float _A, _B; }
float4 f(float4 a) { float x = 1, y = 2; float3 arr[2]; return a; }
```

Actual symbols include:
- struct member `a`, but not `b`
- struct member `pos[2]`, not `pos`
- cbuffer variable `_A`, but not `_B`
- local variable `x`, but not `y` or `arr`

Impact: common HLSL declarations become invisible to definition lookup and chain lookup. The `pos[2]` member name is especially damaging because a later `s.pos` member reference will not match a symbol named `pos[2]`.

Recommended fix:
- Iterate all named children/field children that represent declarators instead of taking only the first `childForFieldName('declarator')`.
- Normalize declarator nodes through one helper that unwraps `identifier`, `field_identifier`, `init_declarator`, `array_declarator`, and other common wrappers to the declared name node.
- Add fixtures for `float a, b;`, `float arr[2];`, cbuffer multi-declarations, and struct array members.

## Verification

Commands run from `unity-shader-nav/` unless noted:

```bash
npm test -w @unity-shader-nav/server
npm run build -w @unity-shader-nav/server
node -e "const {parseHlsl}=require('./server/out/parser/hlsl/parser'); const {collect}=require('./server/out/parser/hlsl/collector'); (async()=>{ const text='float4 f(float4 a, float4 b){ float4 c = a + b; return c; }'; const tree=await parseHlsl(text); const idx=collect(tree.rootNode,text,'file:///t/ids.hlsl',0); console.log(JSON.stringify(idx.references,null,2)); })().catch(e=>{console.error(e); process.exit(1);})"
node -e "const {parseHlsl}=require('./server/out/parser/hlsl/parser'); const {collect}=require('./server/out/parser/hlsl/collector'); (async()=>{ const text='float4 f(float4 a){ float x=1, y=2; float3 arr[2]; return a; }'; const tree=await parseHlsl(text); const idx=collect(tree.rootNode,text,'file:///t/probe.hlsl',0); console.log(JSON.stringify(idx.symbols.filter(s=>s.kind==='localVariable').map(s=>({name:s.name,type:s.declaredType})),null,2)); })().catch(e=>{console.error(e); process.exit(1);})"
node -e "const {parseHlsl}=require('./client/out/server/parser/hlsl/parser'); parseHlsl('float f(){return 1;}').then(t=>console.log('ok',t.rootNode.type)).catch(e=>{console.error(e && e.message || e); process.exit(1);})"
```

Results:
- `npm test -w @unity-shader-nav/server`: passed, 8 files / 39 tests.
- `npm run build -w @unity-shader-nav/server`: passed.
- Identifier-reference probe: returned `[]`, reproducing the missing `identifier` references.
- Local multi-declarator/array probe: returned only `x`, reproducing the missing `y` and `arr`.
- Copied-server parser probe: failed with `ENOENT` for `client/out/grammars/tree-sitter-hlsl.wasm`, reproducing the package-layout grammar issue.

## Summary

Plan03 establishes the parser, shared index types, and a useful first HLSL collector, and the current server workspace tests pass. The main blockers are in the behavioral surface required by later navigation plans: generic identifier references are absent, common declaration forms are partially indexed, and the vendored WASM only works in the server workspace layout rather than the extension runtime layout. Add targeted regression tests for those shapes before wiring this indexer into LSP definition/reference features.
