# Plan 05 Review Fix

Date: 2026-05-23

Source review: `docs/superpowers/plans/plan05review.md`

## Fixed

- Important #1: Added `unityShaderNav` configuration synchronization in the VSCode client. The client now registers the relevant configuration sections with `LanguageClientOptions.synchronize` and explicitly forwards changed `unityShaderNav` settings to the server. The server also refreshes scoped settings before definition resolution so F12 observes updated settings even if a host drops a config-change notification.
- Important #2: Isolated user declaration macro parse failures in `MacroPatternTable`. Invalid `unityShaderNav.declarationMacros` entries are skipped with a warning, while builtin patterns remain active and still fail loudly if their hardcoded definitions are broken.
- Minor #1: Added in-process `.compute` F12 coverage from `#pragma kernel CSMain` to the `CSMain` function declaration.
- Added VSCode integration coverage proving an already-open `.hlsl` document is reindexed after `unityShaderNav.declarationMacros` changes.

## Deferred

- Important #3: `sampler2D $name` / `fixed4 $name` CG legacy declarations are deferred. They are non-call declaration patterns, while Plan 05's matcher is intentionally call/pragma based. The Plan 05 markdown now has an inline `> Note:` recording that this belongs with later non-call declaration support in the normal HLSL declaration collector.
- Minor #2: Ignoring unmatched Unity macro sentinels such as `CBUFFER_END` remains a follow-up for Find References noise reduction.

## Verification

- `npx vitest run tests/macros/table.test.ts tests/macros/integration.test.ts` from `unity-shader-nav/server`: passed.
- `npx vitest run tests/config/settings.test.ts tests/macros/table.test.ts tests/macros/integration.test.ts` from `unity-shader-nav/server`: passed.
- `npm run build; npx tsc -p tests/tsconfig.json; node tests/out/runTest.js` from `unity-shader-nav`: passed, VSCode integration 8/8.
- `npm run test -w @unity-shader-nav/server` from `unity-shader-nav`: passed, server vitest 74/74.
- `npm test` from `unity-shader-nav`: passed, VSCode integration 8/8 and server vitest 74/74.
