# Issue 7 Macro Sentinel Reference Filtering Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or an equivalent TDD loop to implement this plan task-by-task.

**Goal:** Filter Unity structural macro sentinel tokens out of normal reference indexing without breaking real macro declarations, macro definitions, or macro F12.

**Architecture:** Keep the existing declaration macro path for macros that create symbols, such as `CBUFFER_START(UnityPerMaterial)`. Add a small builtin sentinel macro table to the macro subsystem and teach the HLSL collector to skip both bare sentinel identifiers and sentinel call expressions before generic reference collection can emit them as `identifier` or `call` references.

**Tech Stack:** TypeScript, Vitest, web-tree-sitter, existing `MacroPatternTable`, existing HLSL `collect()` / `indexFile()` pipeline.

---

## Root Cause

Issue #7 reproduces in the current indexer:

- `CBUFFER_END` is parsed as a bare `identifier`, and `collectReferences()` emits it as an `identifier` reference.
- `UNITY_INSTANCING_BUFFER_START(Props)` and `UNITY_INSTANCING_BUFFER_END(Props)` are not declaration macros, so `collectReferences()` emits the callee as `call` references and later emits `Props` as ordinary `identifier` references.
- Existing declaration macro handling already prevents `CBUFFER_START(UnityPerMaterial)` from becoming a normal reference while preserving the `UnityPerMaterial` cbuffer symbol.

Minimal reproduction run from `unity-shader-nav/` against current compiled output:

```text
cbuffer-macro.hlsl float4:type, CBUFFER_END:identifier
instanced-prop.hlsl UNITY_INSTANCING_BUFFER_START:call, Props:identifier, UNITY_INSTANCING_BUFFER_END:call, Props:identifier
```

## Acceptance Criteria

- `CBUFFER_END` is not emitted as a normal reference.
- `UNITY_INSTANCING_BUFFER_START(...)` / `UNITY_INSTANCING_BUFFER_END(...)` are not emitted as normal call references, and their structural arguments are not emitted as ordinary identifier references.
- Existing `CBUFFER_START($name)` declaration behavior still registers the captured cbuffer symbol.
- Existing non-sentinel macro definitions and macro call F12 behavior remain covered.
- Cache fingerprinting invalidates pre-fix indexes that still contain sentinel reference noise.
- Focused server tests and build pass.

## Sentinel Scope

Start with common Unity structural macro sentinels that delimit blocks and do not represent useful navigation targets:

- `CBUFFER_END`
- `UNITY_INSTANCING_BUFFER_START`
- `UNITY_INSTANCING_BUFFER_END`
- `UNITY_INSTANCING_CBUFFER_SCOPE_BEGIN`
- `UNITY_INSTANCING_CBUFFER_SCOPE_END`
- `UNITY_DOTS_INSTANCING_START`
- `UNITY_DOTS_INSTANCING_END`

Do not mark declaration or sampling macros such as `TEXTURE2D`, `UNITY_DEFINE_INSTANCED_PROP`, `SAMPLE_TEXTURE2D`, or user `#define` macros as sentinels. These names are treated as Unity structural builtins; if a file defines a macro with the same name, `scanDefines()` should still preserve the definition symbol, but call/reference occurrences are intentionally filtered as structural noise.

## Task 1: Add Failing Macro Sentinel Tests

**Files:**

- Modify: `unity-shader-nav/server/tests/macros/integration.test.ts`
- Read: `unity-shader-nav/server/tests/macros/fixtures/cbuffer-macro.hlsl`
- Read: `unity-shader-nav/server/tests/macros/fixtures/instanced-prop.hlsl`

**Step 1: Add regression tests**

Add focused tests near the existing macro integration tests:

```ts
it('filters structural cbuffer sentinel references while preserving cbuffer declaration', async () => {
  const idx = await indexFile(
    'file:///t/cb.hlsl',
    fixture('cbuffer-macro.hlsl'),
    new MacroPatternTable(),
  );

  expect(idx.symbols.find((s) => s.name === 'UnityPerMaterial')?.kind).toBe('cbuffer');
  expect(idx.references.some((r) => r.name === 'CBUFFER_END')).toBe(false);
});

it('filters structural instancing buffer sentinel calls and arguments', async () => {
  const idx = await indexFile(
    'file:///t/instanced-prop.hlsl',
    fixture('instanced-prop.hlsl'),
    new MacroPatternTable(),
  );

  expect(idx.symbols.find((s) => s.name === '_BaseColor')?.kind).toBe('variable');
  expect(idx.references.map((r) => `${r.name}:${r.context}`).sort()).toEqual([]);
});
```

> Note: During RED/GREEN execution, the existing `UNITY_DEFINE_INSTANCED_PROP(float4, _BaseColor)` declaration macro path already marked `float4` as consumed by the declaration macro call, so `float4:type` was not present even before the sentinel fix. The expected instancing-buffer reference list is therefore empty after filtering the start/end sentinels and their `Props` arguments.

**Step 2: Verify RED**

Run:

```bash
npm run test -w @unity-shader-nav/server -- tests/macros/integration.test.ts
```

Expected: FAIL because `CBUFFER_END`, `UNITY_INSTANCING_BUFFER_START`, `UNITY_INSTANCING_BUFFER_END`, and `Props` are still emitted as references.

**Step 3: Leave RED phase uncommitted**

Task 1 is the RED phase only. Add failing tests and run the focused command to confirm failure. Do not commit this phase separately; the durable task is the completed sentinel filtering fix.

## Task 2: Filter Sentinel References In Collector

**Files:**

- Modify: `unity-shader-nav/server/src/macros/builtin.ts`
- Modify: `unity-shader-nav/server/src/macros/table.ts`
- Modify: `unity-shader-nav/server/src/parser/hlsl/collector.ts`
- Modify: `unity-shader-nav/server/src/cache/fingerprint.ts`
- Modify: `unity-shader-nav/server/tests/macros/integration.test.ts`
- Modify: `unity-shader-nav/server/tests/cache/fingerprint.test.ts`

**Step 1: Add builtin sentinel table**

In `builtin.ts`, export a readonly list or set of sentinel macro names:

```ts
export const BUILTIN_SENTINEL_MACROS = [
  'CBUFFER_END',
  'UNITY_INSTANCING_BUFFER_START',
  'UNITY_INSTANCING_BUFFER_END',
  'UNITY_INSTANCING_CBUFFER_SCOPE_BEGIN',
  'UNITY_INSTANCING_CBUFFER_SCOPE_END',
  'UNITY_DOTS_INSTANCING_START',
  'UNITY_DOTS_INSTANCING_END',
] as const;
```

In `table.ts`, load them into `MacroPatternTable` and expose:

```ts
private readonly sentinelHeads = new Set<string>();

isSentinel(head: string): boolean {
  return this.sentinelHeads.has(head);
}
```

**Step 2: Skip sentinel calls and bare identifiers**

In `collector.ts`, add a helper that detects sentinel nodes through the optional table:

```ts
function isSentinelIdentifier(node: Parser.SyntaxNode, table: MacroPatternTable | undefined): boolean {
  return table?.isSentinel(textOf(node)) === true;
}
```

Update `collectReferences()` to accept `table?: MacroPatternTable`.

For `call_expression`:

- Resolve the callee identifier.
- If the callee is a sentinel, call `markNamedDescendants(st, node)` and return before emitting any call reference.
- This prevents both the sentinel callee and structural arguments such as `Props` from being emitted during the later child visits.

For bare `identifier`:

- If the identifier itself is sentinel, return without emitting a reference.

Do not change `collectMacroDeclaration()`; declaration macros such as `CBUFFER_START($name)` must keep working.

**Step 3: Invalidate stale sentinel-reference cache**

Because sentinel filtering changes `FileIndex.references` without changing the serialized `FileIndex` schema, do not require a schema-shape migration. Include `BUILTIN_SENTINEL_MACROS` in `macroTableHash()` with source `builtin-sentinel` so existing caches written before issue #7 no longer match the new fingerprint.

Add or adjust a focused fingerprint test proving that builtin macro-table hash inputs include the sentinel table. If the implementation cannot expose that cleanly, bump the cache version instead and test the cache-version rejection path.

**Step 4: Verify GREEN**

Run:

```bash
npm run test -w @unity-shader-nav/server -- tests/macros/integration.test.ts
```

Expected: PASS.

**Step 5: Regression check macro F12**

The same test file already includes non-sentinel macro behavior. Ensure these remain green:

- `TEXTURE2D(_MainTex) registers _MainTex as variable`
- `resolves F12 from #pragma kernel CSMain to the CSMain function in .compute files`

**Step 6: Broader verification**

Run:

```bash
npm run test -w @unity-shader-nav/server
npm run build
```

Expected: both PASS.

**Step 7: Commit**

```bash
git add unity-shader-nav/server/tests/macros/integration.test.ts \
  unity-shader-nav/server/src/macros/builtin.ts \
  unity-shader-nav/server/src/macros/table.ts \
  unity-shader-nav/server/src/parser/hlsl/collector.ts \
  unity-shader-nav/server/src/cache/fingerprint.ts \
  unity-shader-nav/server/tests/cache/fingerprint.test.ts
git commit -m "fix(issue-7): filter Unity macro sentinel references"
```

## Documentation And GitHub Update

After code review passes:

- Add or update a short review note if the implementation deviates from this plan.
- Comment on GitHub issue #7 with:
  - root cause summary
  - implementation summary
  - verification commands and results
  - commit SHA
  - request for manual validation before closing

Do not close issue #7 until the human verifier confirms the behavior.
