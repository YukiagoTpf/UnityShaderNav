# Plan 12 Fix

Source review docs:
- `docs/superpowers/plans/plan12-self-review.md`
- `docs/superpowers/plans/plan12review.md`

Fix subagent: Carson (`019e547e-4723-7730-9883-97d52fc2fbd8`)
Fix commit: `ff5d79d fix(plan-12): harden macro definition indexing`
Date: 2026-05-23

## Fixes

### P1: Warm cache could hide macro symbols

- Bumped `CACHE_VERSION` from 2 to 3 in `unity-shader-nav/shared/src/cache.ts`.
- Added `CacheStore` regression coverage proving a pre-macro-symbol manifest with `version: 2` is rejected.

### P2: Defines inside multi-line block comments were indexed

- Updated `scanDefines()` to carry `/* ... */` block-comment state across lines while preserving existing `//` stripping behavior.
- Added regression coverage for a disabled `#define` inside a multi-line block comment.

## Verification

Fix subagent reported:
- RED: `npm run test -w @unity-shader-nav/server -- --run tests/parser/preproc/scanDefines.test.ts` failed before the comment fix on `DISABLED_IN_BLOCK`.
- RED: `npm run test -w @unity-shader-nav/server -- --run tests/cache/cacheStore.test.ts` failed before the cache version bump because `version: 2` was still accepted.
- `npm run build`: PASS.
- `npm run test -w @unity-shader-nav/server -- --run tests/parser/preproc/scanDefines.test.ts tests/cache`: PASS, 6 files / 21 tests.

Main agent re-verified:
- `git diff --check 93a49b2..HEAD`: PASS.
- `npm run test -w @unity-shader-nav/server -- --run tests/parser/preproc/scanDefines.test.ts tests/cache`: PASS, 6 files / 21 tests.
