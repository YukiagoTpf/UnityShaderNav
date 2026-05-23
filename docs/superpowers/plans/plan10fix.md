# Plan 10 Review Fix

Date: 2026-05-23

Source review: `docs/superpowers/plans/plan10review.md`

## Fixes Applied

### P2 - Same-named struct members crossing Pass boundaries

`buildHlslSymbols()` now assigns each `structMember` to the nearest preceding same-named `struct` declaration instead of grouping globally by `parentType`. This keeps common per-Pass structs such as `Attributes` scoped to their local declaration and prevents their ranges from expanding across multiple Pass blocks.

Regression coverage: `server/tests/index/documentSymbols.test.ts` includes a `.shader` case with two Pass blocks that both declare `Attributes`; each Pass receives only its own member.

### P2 - Cache schema invalidation for `FileIndex.structure`

`CACHE_VERSION` was bumped from `1` to `2` so Plan 09 manifests generated before `FileIndex.structure` are ignored and reindexed. This prevents warm cache restore from losing `Shader > SubShader > Pass` document-symbol nesting.

Regression coverage: `server/tests/cache/cacheStore.test.ts` now explicitly checks that manifests with `CACHE_VERSION - 1` are ignored.

### P2 - Document symbol request lifecycle

`registerDocumentSymbolHandler()` is now async, calls `workspaceForOrCreateFile()`, and accepts an optional `RequestSuspender`, matching the definition handler lifecycle for cold start, rebuild, and standalone lazy workspace creation. `server.ts` passes the existing suspender when registering the handler.

Regression coverage: `server/tests/handlers/documentSymbol.test.ts` verifies both normal lazy workspace lookup and that requests wait until the suspender releases.

## Verification

- `npm run test -w @unity-shader-nav/server -- --run tests/index/documentSymbols.test.ts tests/handlers/documentSymbol.test.ts tests/cache/cacheStore.test.ts`: PASS, 10/10 tests.
- `npm run build`: PASS, shared/server/client build and bundle completed.
