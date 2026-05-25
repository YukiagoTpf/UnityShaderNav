# Issue 9 Code Review

Reviewer: Socrates (`019e5cb1-36b9-7423-b7a0-c756e91330e3`)
Range: `96222b529fa19f31dd4867916438115630bdf2d0..4b521a330715e568e7da5b9a08745d127b4b8c2d`
Verdict: CHANGES_REQUESTED

## Findings

### Important

- `unity-shader-nav/server/src/index/chainLookup.ts`: unsupported receiver expressions can fall back to the first identifier. Example: `surface.Make().positionWS` is captured as receiver `surface.Make()`, chain parsing fails, then `inferReceiverType()` reduces it to `surface`. That can produce false-positive F12 / Find References targets for unsupported call-like receivers.

### Minor

- `unity-shader-nav/server/tests/index/chainLookup.test.ts`: RHS assignment inference has nearest-preceding coverage, but should also lock the exact-one function boundary with zero-candidate and ambiguous-candidate tests.

## Reviewer Verification

- Focused issue #9 suite passed: `npm run test -w @unity-shader-nav/server -- --run tests/index/wordAt.test.ts tests/index/chainLookup.test.ts tests/parser/hlsl/collector.test.ts tests/cache/cacheStore.test.ts tests/index/referenceResolver.test.ts tests/handlers/definition.test.ts tests/handlers/references.test.ts` (97 tests).
- Full server suite passed: `npm run test -w @unity-shader-nav/server` (46 files / 287 tests).
- Reviewer did not run `npm run build` to keep review read-only.
