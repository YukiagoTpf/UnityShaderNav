# Issue 9 Code Review Fixes

## Disposition

- Accepted the Important finding: unsupported call-like receiver expressions must not fall back to their root identifier.
- Accepted the Minor finding: RHS assignment inference should have explicit zero-candidate and ambiguous-candidate tests.

## Fixes

- Added `resolveMember()` regression coverage for `surface.Make().positionWS`, asserting no result for unsupported call-like receivers.
- Added RHS inference boundary coverage for:
  - no visible function candidate for the assignment call
  - multiple visible function candidates for the assignment call
- Changed chain lookup so receiver expression parse failure returns no receiver type. Direct identifiers still parse successfully, so supported L1/L2/L3a behavior remains intact.

## Verification

- `npm run test -w @unity-shader-nav/server -- --run tests/index/chainLookup.test.ts`: PASS (11 tests).
- `npm run build`: PASS.
- `npm run test -w @unity-shader-nav/server`: PASS (46 files / 290 tests).
