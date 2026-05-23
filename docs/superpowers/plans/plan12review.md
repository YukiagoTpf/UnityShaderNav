# Plan 12 Code Review

Reviewer: Anscombe (`019e5476-ff2c-78c3-b375-9e3bc20e8350`)
Range: `93a49b2..b0785e1`
Date: 2026-05-23

## Findings

### P1 - Cache version was not bumped after adding macro symbols

`unity-shader-nav/shared/src/cache.ts` still has `CACHE_VERSION = 2`. Plan 12 changes `FileIndex.symbols` semantics by adding `kind='macro'` entries for `#define` directives. Plan 09 cache restore accepts unchanged files with matching version/fingerprint and upserts the old cached index directly, so an unchanged cached `Macros.hlsl` can be restored without macro symbols. Impact: F12 from a macro use in another file can fail after upgrade until the definition file is reindexed.

### P2 - `scanDefines` indexes defines inside multi-line block comments

`unity-shader-nav/server/src/parser/preproc/scanDefines.ts` strips `//` comments but does not carry `/* ... */` state. A disabled block such as:

```hlsl
/*
#define DISABLED 1
*/
#define REAL 1
```

returns both `DISABLED` and `REAL`, creating false macro definition targets.

## Coverage Notes

Current tests cover simple define scanning, pure `.hlsl` indexing, `.shader` HLSL block offsets, and one cross-file F12 macro case. Missing coverage: cache invalidation for pre-Plan-12 manifests and multi-line block-comment false positives.

## Commands Checked By Reviewer

- `git diff --check 93a49b2..HEAD`: PASS.
- `npm run test -w @unity-shader-nav/server -- --run tests/parser/preproc/scanDefines.test.ts tests/parser/hlsl/fileIndexer.test.ts`: PASS, 8/8.
- Local `scanDefines` repro confirmed the block-comment false positive.
- `npm test` and `node tests/out/runTest.js` failed in Electron activation/unresponsive host paths; reviewer did not tie those failures to Plan 12.
