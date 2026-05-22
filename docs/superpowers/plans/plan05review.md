# Plan 05 Code Review

Review range: `7fb708cb7b7c8eaa3cec97c4134bb8f8e44f8840..6946b2a6d6ab84e6aff190168ec42549ec850825`

Reviewer: code-review subagent `019e5071-5ce2-7090-8eb1-17e748289866`

## Critical

None.

## Important

1. `unity-shader-nav/client/src/client.ts` / `unity-shader-nav/server/src/server.ts`
   Dynamic settings updates are probably not delivered. The server registers `onDidChangeConfiguration`, but the client uses `synchronize: {}` without `configurationSection: 'unityShaderNav'`, so VSCode languageclient will not register config-change sync for this section. Impact: adding `unityShaderNav.declarationMacros` after startup may not rebuild the `MacroPatternTable` or reindex open documents, failing the settings-pipeline acceptance. Fix by configuring sync for `unityShaderNav` or explicitly forwarding config changes, then add a test that changes config and verifies an already-open `MY_TEX2D($name)` document is reindexed.

2. `unity-shader-nav/server/src/macros/table.ts` / `unity-shader-nav/server/src/macros/patterns.ts`
   User-provided macro patterns are compiled without validation isolation. One malformed `declarationMacros` entry throws during `new MacroPatternTable(...)` on startup or config change. Impact: a bad setting can break initialization/reindex instead of falling back to builtins. Fix by validating/skipping bad user patterns with a console warning, while keeping builtin patterns active.

3. `unity-shader-nav/server/src/macros/builtin.ts`
   The builtin table omits the ADR/spec-mentioned CG legacy declaration shapes such as `sampler2D $name` / `fixed4 $name`; there is also no `cg-legacy.hlsl` fixture despite the plan listing it. Verification showed `sampler2D _MainTex; fixed4 _Color;` currently produces references only, not symbols. Fix either by supporting non-call declaration patterns or by documenting this as deferred with a plan note.

## Minor

1. `unity-shader-nav/server/tests/macros/integration.test.ts`
   Case 7 coverage only asserts that `.compute` `#pragma kernel CSMain` creates a pragma reference; it does not exercise F12/`resolveDefinition` from the pragma token to the `CSMain` function. Add an in-process definition test or test-electron `.compute` case.

2. `unity-shader-nav/server/src/parser/hlsl/collector.ts`
   `markNamedDescendants` correctly suppresses duplicate references for matched macro declaration calls, but unmatched macro sentinels like `CBUFFER_END` and instancing buffer start/end still enter references as normal identifiers/calls. Not blocking for Plan 05 F12, but it will add noise for later Find References unless filtered or whitelisted as ignored macros.

## Reviewer Verification

`npm test` passed: VSCode integration 7/7 and server vitest 71/71.

## Suggested Fix Checklist

- Add client config synchronization for `unityShaderNav`.
- Add dynamic settings/reindex test for a custom declaration macro on an open document.
- Guard user macro parsing so bad settings do not break builtin indexing.
- Add CG legacy declaration support or explicitly defer it in the plan.
- Add `.compute` F12 coverage for `#pragma kernel CSMain`.
- Optionally filter ignored Unity macro sentinels from references.
