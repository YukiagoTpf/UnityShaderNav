# Issue 3 Index Cache Performance And Persistence Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or execute in the main agent with plan/code review gates.

**Goal:** Make large Unity project indexing and cache restore measurably safer and faster, while hardening cache writes against same-cache concurrent server processes.

**Root Cause:** Issue #3 is not one navigation bug; it is a set of bottlenecks and persistence risks in the index lifecycle. `Workspace.fullScan()`, cache restore validation, missing-file refresh, and `persist()` all process files serially. `CacheStore.writeManifest()` writes a unique temp file but then removes `index.json` before renaming the temp file, creating a short cross-process window where a reader can see no manifest at all if another process is saving.

**Architecture:** Keep the cache manifest monolithic for now, because the measured synthetic baseline is still under 1 MB for 800 files and write time is not the dominant cost. Add a repeatable benchmark script, introduce bounded concurrency at file walking/indexing/stat/snapshot boundaries, and change cache persistence to same-directory temp write plus direct atomic replace without deleting the existing manifest first.

**Tech Stack:** TypeScript, Vitest, Node `fs/promises`, existing `Workspace`, `CacheManager`, `CacheStore`, synthetic Unity-project benchmark script.

---

## Baseline Measurement

Measured before behavior changes on 2026-05-25 after `npm run build`, using a temporary synthetic Unity project with 800 `.hlsl` files:

```json
{
  "files": 800,
  "coldMs": 263.9132,
  "warmMs": 83.924,
  "persistMs": 20.6975,
  "cacheBytes": 880337
}
```

Real local smoke context: `F:\Project\UnityProject\Pandora` currently contains 1007 shader source files by extension. The implementation benchmark should support both synthetic and real-project smoke usage, but the automated test suite should not depend on that private project path.

## Cache Format Decision

Do not shard or compress cache JSON in this issue. The current monolithic file is easy to validate, easy to atomically replace, and the baseline size/write time does not justify adding shard invalidation, partial-write recovery, or compression CPU cost. Revisit sharding/compression only if the repeatable benchmark shows cache write size/time becoming the bottleneck on URP/HDRP-scale or real project smoke runs.

## Acceptance Criteria

- Repeatable benchmark script exists and reports cold scan, warm restore, persist/write time, cache size, and file count.
- File walking and indexing use bounded concurrency instead of unbounded or fully serial work.
- Warm cache restore validates cached file metadata with bounded concurrency.
- Cache persistence snapshots indexed files with bounded concurrency.
- Cache writes never remove the previous manifest before the replacement manifest is durable enough to rename.
- Regression tests cover old-manifest preservation when final rename fails and concurrent/best-effort saves where practical.
- Focused server tests, full server tests, and build pass.

## Task 0: Commit This Reviewed Fix Plan

**Files:**

- Create: `docs/superpowers/plans/2026-05-25-issue-3-fixplan.md`

**Step 1: Dispatch planreviewer subagent**

Ask for Critical/Important/Minor findings against issue #3 acceptance criteria, TDD sequencing, and scope control.

**Step 2: Apply accepted plan feedback**

If the reviewer finds a real gap, edit this plan before implementation.

**Step 3: Commit the reviewed plan**

```bash
git add docs/superpowers/plans/2026-05-25-issue-3-fixplan.md
git commit -m "docs(plans): add issue 3 performance fix plan"
```

## Task 1: Add Repeatable Index/Cache Benchmark

**Files:**

- Create: `unity-shader-nav/scripts/benchmark-index-cache.mjs`
- Modify: `unity-shader-nav/package.json`

**Step 1: Write the benchmark script**

Create a Node script that:

- Accepts `--files <n>` for synthetic temporary Unity project generation.
- Accepts `--project <path>` for real project smoke runs.
- Runs through existing compiled `server/out` and `shared/out` code.
- Measures cold bootstrap, warm bootstrap, explicit persist, cache file size, and shader file count.
- Prints stable JSON to stdout.

**Step 2: Add npm entry**

Add:

```json
"bench:issue3": "node scripts/benchmark-index-cache.mjs"
```

**Step 3: Verify**

```bash
npm run build
npm run bench:issue3 -- --files 200
npm run bench:issue3 -- --files 800
```

Expected: JSON includes `files`, `coldMs`, `warmMs`, `persistMs`, and `cacheBytes`. Record the 800-file result in this plan before changing cache/workspace behavior so the before/after values come from the same committed benchmark script.

**Step 4: Commit**

```bash
git add unity-shader-nav/scripts/benchmark-index-cache.mjs unity-shader-nav/package.json
git commit -m "chore(issue-3): add index cache benchmark"
```

## Task 2: Preserve Existing Cache Manifest On Failed Replace

**Files:**

- Modify: `unity-shader-nav/server/src/cache/cacheStore.ts`
- Modify: `unity-shader-nav/server/tests/cache/cacheStore.test.ts`

**Step 1: Write failing cache-store tests**

Add a test that:

- Saves an initial valid manifest.
- Spies on `fs.rename` to throw during a second save.
- Expects `save()` to reject.
- Expects `load()` still returns the initial manifest.

This should fail against the current `rm(index.json)` then `rename(tmp,index.json)` implementation because the old manifest is removed before the failed replace.

Add a practical same-directory multi-writer test with two separate `CacheStore` instances pointed at the same cache directory. Run concurrent saves and assert:

- `load()` returns a valid manifest.
- No `.tmp` files remain after the saves settle.

This is same-process test coverage for distinct store instances. True cross-process interleaving is covered by design: unique per-save temp file names, process-local queues only within a process, and direct replace without a pre-delete no-manifest window.

**Step 2: Run RED**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/cache/cacheStore.test.ts
```

Expected: FAIL on old-manifest preservation.

**Step 3: Implement atomic replace**

Change `writeManifest()` to:

- Create the cache directory.
- Write a unique temp file in the same directory.
- Directly `rename(tmpPath, this.path)` without first deleting `this.path`.
- Best-effort remove the temp file if write/rename fails.

Keep the existing process-local save queue.

Clarification: this hardens concurrent readers/writers by eliminating the no-manifest window. It does not add `fsync` or claim power-loss durability.

**Step 4: Run GREEN and commit**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/cache/cacheStore.test.ts
git add unity-shader-nav/server/src/cache/cacheStore.ts unity-shader-nav/server/tests/cache/cacheStore.test.ts
git commit -m "fix(issue-3): preserve cache manifest during replace"
```

## Task 3: Add Bounded Concurrency Utilities And File Walking Coverage

**Files:**

- Create: `unity-shader-nav/server/src/workspace/concurrency.ts`
- Create: `unity-shader-nav/server/tests/workspace/concurrency.test.ts`
- Modify: `unity-shader-nav/server/src/workspace/walkFiles.ts`
- Modify: `unity-shader-nav/server/tests/workspace/walkFiles.test.ts`

**Step 1: Write concurrency helper tests**

Add direct tests for `mapWithConcurrency()`:

- Empty input returns `[]`.
- Output order matches input order even when later items finish earlier.
- Active task count never exceeds the configured limit.
- A task failure rejects the returned promise.

**Step 2: Run RED**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/workspace/concurrency.test.ts
```

Expected: FAIL because `concurrency.ts` does not exist yet.

**Step 3: Write walk coverage**

Add a test with nested shader directories and an exclusion pattern proving `walkFiles()` returns the expected files after the implementation sorts output deterministically.

Do not rely on filesystem enumeration randomness for RED; this is regression coverage for deterministic output, not the primary failing test.

**Step 4: Implement helper and bounded walk**

Add `mapWithConcurrency()` with order-preserving results and a conservative default limit helper. Update `walkFiles()` to process directory reads with bounded workers, preserve exclusion behavior, and return sorted paths for deterministic downstream manifests/tests.

**Step 5: Run GREEN and commit**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/workspace/concurrency.test.ts
npm run test -w @unity-shader-nav/server -- --run tests/workspace/walkFiles.test.ts
```

Expected: PASS.

```bash
git add unity-shader-nav/server/src/workspace/concurrency.ts unity-shader-nav/server/tests/workspace/concurrency.test.ts unity-shader-nav/server/src/workspace/walkFiles.ts unity-shader-nav/server/tests/workspace/walkFiles.test.ts
git commit -m "feat(issue-3): bound shader file walking"
```

## Task 4: Bound Workspace Index, Restore, And Persist Work

**Files:**

- Modify: `unity-shader-nav/server/src/workspace/workspace.ts`
- Modify: `unity-shader-nav/server/tests/workspace/workspace.test.ts`

**Step 1: Write failing behavioral tests**

Add tests that prove:

- Warm restore still restores valid cached files and refreshes invalid files after concurrent validation.
- `persist()` still writes all disk indexes after concurrent snapshotting.
- Persisted manifest file records are sorted by URI, so concurrent indexing/snapshot completion order cannot make cache JSON order drift.
- `fullScan()` still indexes user files and package files after concurrent indexing.

Prefer behavior assertions over brittle timing assertions. The only required RED assertion in this task is deterministic manifest ordering if the current serial/index insertion order does not match sorted URI order; the other tests are regression coverage for behavior that must remain intact after introducing concurrency.

**Step 2: Run RED**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/workspace/workspace.test.ts
```

Expected: Any new assertions that depend on exposed helper behavior or deterministic cache order fail before implementation.

**Step 3: Implement bounded workspace work**

Use `mapWithConcurrency()` in:

- `bootstrapFromCache()` for `isValid()` checks.
- Changed-file refresh inside cache restore.
- `indexMissingDiskFiles()`.
- `fullScan()`.
- `persist()` snapshot collection.

Use small constants such as `INDEX_CONCURRENCY = 8` and `CACHE_IO_CONCURRENCY = 32`. Keep all writes to `store`, `global`, and `globalRefs` inside the same single Node process; no worker threads are introduced.

Before saving a manifest, sort `CachedFile` records by URI. This preserves deterministic cache JSON even when indexing or snapshotting finishes out of input order.

**Step 4: Run GREEN and commit**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/workspace/workspace.test.ts
git add unity-shader-nav/server/src/workspace/workspace.ts unity-shader-nav/server/tests/workspace/workspace.test.ts
git commit -m "feat(issue-3): bound workspace index cache work"
```

## Task 5: Re-measure And Document Results

**Files:**

- Modify: `docs/superpowers/plans/2026-05-25-issue-3-fixplan.md`
- Modify: `docs/superpowers/PROGRESS.md`

**Step 1: Run benchmark after implementation**

```bash
npm run build
npm run bench:issue3 -- --files 800
```

Record the JSON output in this plan.

**Step 2: Run final verification**

```bash
npm run test -w @unity-shader-nav/server
npm run build
```

Expected: PASS.

**Step 3: Update progress**

Update `docs/superpowers/PROGRESS.md` issue #3 row/status and recent debug section with:

- Root cause.
- Chosen cache format decision.
- Verification commands/results.
- Any remaining manual real-project smoke note.

**Step 4: Commit docs/progress**

```bash
git add docs/superpowers/plans/2026-05-25-issue-3-fixplan.md docs/superpowers/PROGRESS.md
git commit -m "docs(issue-3): record performance verification"
```

## Task 6: Code Review, Fixes, GitHub Comment, Close

**Files:**

- Create: `docs/superpowers/plans/2026-05-25-issue-3-review.md`
- Create: `docs/superpowers/plans/2026-05-25-issue-3-fixreview.md`

**Step 1: Dispatch codereviewer subagent**

Review scope should include all issue #3 implementation commits after the fix-plan commit. Ask for Critical/Important/Minor findings against issue #3 acceptance criteria and performance/persistence regression risk.

**Step 2: Fix accepted findings**

Verify each finding. Fix Critical/Important findings, rerun focused tests, and record disposition in `2026-05-25-issue-3-fixreview.md`.

**Step 3: Final verification**

```bash
npm run test -w @unity-shader-nav/server
npm run build
git status --short
```

Expected: tests/build pass; only intentional review/docs changes remain before the final commit.

**Step 4: Commit review artifacts and accepted fixes**

```bash
git add docs/superpowers/plans/2026-05-25-issue-3-review.md docs/superpowers/plans/2026-05-25-issue-3-fixreview.md
git add unity-shader-nav/server/src unity-shader-nav/server/tests unity-shader-nav/scripts unity-shader-nav/package.json docs/superpowers/PROGRESS.md
git commit -m "fix(issue-3): address performance review findings"
```

If the code review finds no accepted code fixes, commit only review artifacts/progress:

```bash
git add docs/superpowers/plans/2026-05-25-issue-3-review.md docs/superpowers/plans/2026-05-25-issue-3-fixreview.md docs/superpowers/PROGRESS.md
git commit -m "docs(issue-3): record performance code review"
```

**Step 5: Comment on GitHub issue #3 and close it**

Post a comment containing:

- Root cause summary.
- Benchmark before/after.
- Cache format decision.
- Implementation summary.
- Verification commands/results.
- Commit SHAs.

Then close issue #3 as requested by the user.

---

## Acceptance Checklist

- [ ] Plan reviewed by subagent before implementation.
- [ ] Benchmark script exists and can run synthetic and real-project smoke modes.
- [ ] Baseline and after measurements recorded.
- [ ] File walking/indexing/restore/persist use bounded concurrency.
- [ ] Cache replace preserves old manifest if final rename fails.
- [ ] Cache JSON remains monolithic by documented decision.
- [ ] Regression tests cover cache integrity and workspace behavior.
- [ ] Code review completed, accepted findings fixed, review docs landed.
- [ ] GitHub issue #3 updated and closed.
