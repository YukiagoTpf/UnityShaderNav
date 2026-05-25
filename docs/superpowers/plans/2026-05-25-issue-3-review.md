# Issue 3 Code Review

Reviewer: Carver (`019e5fd2-823f-7473-8399-f603034ad657`)
Range: `08ede71..a4606e6`
Verdict: CHANGES_REQUESTED

## Findings

### Important

- `unity-shader-nav/server/src/workspace/walkFiles.ts`: `walkFiles()` started a new `mapWithConcurrency(..., 16)` inside every recursive directory call. That bounded each directory's immediate children, but not the whole walk. A broad/deep tree could fan out into many concurrent `readdir` calls, so the acceptance criterion "File walking uses bounded concurrency" was only partially met.

### Minor

- `unity-shader-nav/server/tests/cache/cacheStore.test.ts`: the two-`CacheStore` concurrency test is useful, but same-process saves are still serialized by the static `saveQueues` map. It validates public behavior and tmp cleanup, but does not meaningfully exercise interleaved final renames. This remains acceptable for "where practical"; true cross-process coverage is documented as design rationale rather than a deterministic unit test.

## Reviewer Assessment

Cache integrity coverage is meaningful for the previous remove-then-rename hazard. `mapWithConcurrency()` and deterministic manifest ordering have direct tests. The remaining blocker before closing issue #3 is making file walking use a global worker pool and covering the cap.
