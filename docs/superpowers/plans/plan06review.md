# Plan 06 Code Review

Date: 2026-05-23

Scope: `268da2e..11ce08d` (Plan 06 include resolver implementation)

Reviewer: code-review subagent `019e50b8-2653-7ca0-b86f-0122f3016e35`

## Summary

No P1/P2 findings.

Plan 06 acceptance is covered:

- Include resolver search priority is relative -> Assets -> includeDirectories.
- `Packages/...` returns `null` without Plan 07 package mapping.
- F12 on an include path returns the target file.
- Case-insensitive fallback returns the real on-disk path and logs a warning through the definition handler.
- Include directives are recorded as `context: 'include'` references.
- Unity project root autodetection is covered.
- test-electron fixture path is correct from compiled integration tests.

`server/src/include/circularGuard.ts` was not implemented. The reviewer did not classify this as required for Plan 06 because the plan describes it as reserved for Plan 08 incremental indexing and no Plan 06 acceptance item depends on it.

## Findings

### P3: Block comments can produce false include directives

File: `unity-shader-nav/server/src/parser/include/lineScanner.ts`

`scanIncludes()` strips `//` line comments but does not track `/* ... */` block comments. A commented-out include inside a block comment can be indexed as a real include, and `definition.ts` reuses the same scanner for F12 on include paths.

Example:

```hlsl
/*
#include "Common.hlsl"
*/
```

Recommended fix: make `scanIncludes()` block-comment aware and add a unit test that ignores includes inside multi-line block comments.

## Verification Reported By Reviewer

- `npm run build` passed.
- `npm run test -w @unity-shader-nav/server` passed: 89 tests.
- `npm test` passed: test-electron 10 passing + server 89 tests.
