# Plan 12 Self Review

Reviewer: main agent
Range: `93a49b2..0006d3b`
Date: 2026-05-23

## Findings

### P1 - Cache version not bumped after adding macro symbols

Plan 12 changes `FileIndex.symbols` semantics: files now include `kind='macro'` entries for `#define` directives. Existing Plan 09 cache manifests with `CACHE_VERSION = 2` can still be restored, but those cached file indexes were produced before macro collection and therefore contain no macro symbols. A warm start can make F12 on macros fail until the file is reindexed. Bump `CACHE_VERSION` and add/adjust cache coverage so old manifests are discarded.

### P2 - `scanDefines` indexes defines inside multi-line block comments

`scanDefines()` strips `//` comments but does not track `/* ... */` state. A disabled block such as `/* #define DISABLED 1 */` can become a real macro symbol. The include scanner already carries block-comment state; macro scanning should use equivalent semantics and test multi-line comments.

## Verification Run

- `npm run test -w @unity-shader-nav/server -- --run tests/parser/preproc/scanDefines.test.ts`: failed before implementation because the module was missing, then passed 2/2.
- `npm run test -w @unity-shader-nav/server -- --run tests/parser/hlsl/fileIndexer.test.ts`: failed before fileIndexer integration on the two macro-symbol cases, then passed 6/6.
- `npm test`: passed after Task 3, including build, test-electron, and workspace vitest.
