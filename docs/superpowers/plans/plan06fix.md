# Plan 06 Fix

Date: 2026-05-23

Source review: `docs/superpowers/plans/plan06review.md`

Fix subagent: `019e50be-44b3-7043-8c32-20a4d7b12438`

## Fixed

### P3: Block-commented includes were scanned as real include directives

`scanIncludes()` now tracks `/* ... */` block comments while scanning lines. Commented content is replaced with spaces so existing character offsets for real include paths stay stable.

Regression coverage added in `unity-shader-nav/server/tests/parser/include/lineScanner.test.ts`:

- Real includes before and after a multi-line block comment are still detected.
- `#include` inside the block comment is ignored.

## Verification

Fix subagent verified:

- RED: `npm run test -w @unity-shader-nav/server -- --run tests/parser/include/lineScanner.test.ts` failed before the implementation because `Fake.hlsl` was scanned.
- GREEN: same command passed with 3 tests.

Main agent verified after reviewing the diff:

- `npm run test -w @unity-shader-nav/server -- --run tests/parser/include/lineScanner.test.ts` passed: 1 file / 3 tests.
- `npm run build` passed for all workspaces.

## Deferred

No Plan 06 blockers remain from review. `server/src/include/circularGuard.ts` remains deferred to Plan 08 because no Plan 06 task or acceptance item depends on it.
