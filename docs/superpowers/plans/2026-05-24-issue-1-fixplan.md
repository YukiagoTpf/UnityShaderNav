# Issue 1 Scope-Aware Navigation Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Fix issue #1 so F12 and Find References bind global HLSL names through scope, include-chain visibility, and canonical declaration targets instead of name-only project-wide matches.

**Root Cause:** `resolveDefinitionSymbols()` currently appends every same-name global symbol from `GlobalSymbolIndex.lookup(name)` when a current-file scoped symbol does not win. `registerReferencesHandler()` starts from exact targets, but for global symbols it still reduces candidate references to same name + kind/context compatibility, so unrelated shaders with same-name helpers can be pulled into results.

**Architecture:** Add a small include-visibility helper that computes the transitive include closure for the file being resolved. Pass this visibility set into definition/member/reference target resolution. Make Find References compare candidate occurrences against exact target declaration identity (`uri + range + kind`) after resolving each candidate occurrence in that candidate file's own include closure.

**Tech Stack:** TypeScript, Vitest, VSCode LSP handlers, existing `IndexStore`, `GlobalSymbolIndex`, `GlobalReferenceIndex`, and `resolveInclude()`.

---

### Task 1: Add Red Tests For Include-Scoped Definitions

**Files:**
- Modify: `unity-shader-nav/server/tests/handlers/definition.test.ts`

**Step 1: Write the failing test**

Add a handler-level test with three real temp files under a per-test directory:

- `<temp>/Assets/Main.hlsl` includes `Shared.hlsl` and calls `Helper()`
- `<temp>/Assets/Shared.hlsl` defines `Helper`
- `<temp>/Assets/Other.hlsl` also defines `Helper`

Index all three files with `indexFile()` so include references are produced and `resolveInclude()` can resolve real paths. Seed `workspace.store` and `workspace.global` with all three indexes, but only `Main.hlsl` includes `Shared.hlsl`. Assert F12 on `Main.hlsl` returns only the `Shared.hlsl` definition.

**Step 2: Verify RED**

Run:

```bash
npm run test -w @unity-shader-nav/server -- server/tests/handlers/definition.test.ts -t "filters global definition candidates to the transitive include chain"
```

Expected: FAIL because the current implementation returns both `Shared.hlsl` and `Other.hlsl`.

### Task 2: Add Red Tests For Canonical Find References

**Files:**
- Modify: `unity-shader-nav/server/tests/handlers/references.test.ts`

**Step 1: Write the failing test**

Add a handler-level test with two independent shader users in a real temp directory:

- `Main.hlsl` includes `Shared.hlsl` and calls `Helper()`
- `OtherUse.hlsl` includes `OtherShared.hlsl` and calls `Helper()`
- both include files define a `Helper` function with different declaration ranges/URIs

Index all four files with `indexFile()` so include references are produced and `resolveInclude()` can resolve real paths. Seed `workspace.store`, `workspace.global`, and `workspace.globalRefs` with all four indexes. Assert Find References on `Main.hlsl` returns only:

- the `Shared.hlsl` declaration when `includeDeclaration` is true
- the call in `Main.hlsl`

It must not return `OtherShared.hlsl` declaration or `OtherUse.hlsl` call.

**Step 2: Verify RED**

Run:

```bash
npm run test -w @unity-shader-nav/server -- server/tests/handlers/references.test.ts -t "filters global references to the canonical include-visible target"
```

Expected: FAIL because the current implementation resolves same-name calls in unrelated files through project-wide globals.

### Task 3: Implement Include Visibility

**Files:**
- Create: `unity-shader-nav/server/src/index/visibility.ts`
- Modify: `unity-shader-nav/server/src/index/index.ts`

**Implementation:**

- Add `async collectVisibleUriKeys(store, includeCtx, rootUri): Promise<Set<string>>`:
  - start with `rootUri`
  - inspect the file's indexed `include` references
  - resolve each include through `resolveInclude(reference.name, file.uri, includeCtx)`
  - convert resolved absolute paths with `pathToFileURL(...).href`
  - traverse transitively through indexed included files
  - compare using existing `uriKey()`
- Export the helper from `src/index/index.ts`.

**Step 1: Run focused visibility tests through handler RED tests**

Do not add production behavior yet. Re-run the two RED tests to confirm they still fail for the original reason.

### Task 4: Apply Visibility To Definition/Member Target Resolution

**Files:**
- Modify: `unity-shader-nav/server/src/index/symbolResolver.ts`
- Modify: `unity-shader-nav/server/src/index/referenceResolver.ts`
- Modify: `unity-shader-nav/server/src/index/chainLookup.ts`
- Modify: `unity-shader-nav/server/src/handlers/definition.ts`

**Implementation:**

- Add an optional `visibleUriKeys` resolution option.
- Filter cross-file global symbols to `visibleUriKeys` when provided.
- In `chainLookup.ts`, filter both cross-file `global.lookup(receiver)` used for receiver type inference and cross-file `global.lookup(member)` used for member lookup by `visibleUriKeys`.
- Preserve current behavior when no visibility set is provided so pure unit tests remain useful.
- In the definition handler, after ensuring the current document has an index, `await collectVisibleUriKeys(...)` and pass it into `resolveDefinition()` and `resolveMember()`.

**Step 1: Verify GREEN for definition**

Run:

```bash
npm run test -w @unity-shader-nav/server -- server/tests/handlers/definition.test.ts -t "filters global definition candidates to the transitive include chain"
```

Expected: PASS.

### Task 5: Apply Canonical Target Filtering To References

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/references.ts`

**Implementation:**

- Compute `visibleUriKeys` for the request file before resolving initial targets.
- Pass visibility into `resolveReferenceTargets()`.
- When including declarations for global targets, require exact `sameTarget()` identity instead of same kind only.
- When evaluating each candidate reference, compute that candidate file's own visible URI set and pass it into `resolveReferenceTargetsForName()` / `resolveReferenceTargetsForMemberReference()`.
- For candidate references, after resolving candidate targets with that candidate file's visible URI set, require `sameTarget(candidate, activeTarget)` for global targets as well as scoped/member targets.
- Keep scoped local/parameter and struct member exact-target filtering unchanged.

**Step 1: Verify GREEN for references**

Run:

```bash
npm run test -w @unity-shader-nav/server -- server/tests/handlers/references.test.ts -t "filters global references to the canonical include-visible target"
```

Expected: PASS.

### Task 6: Full Verification And Commit

**Files:**
- All changed files from tasks above

**Step 1: Run focused tests**

```bash
npm run test -w @unity-shader-nav/server -- server/tests/handlers/definition.test.ts server/tests/handlers/references.test.ts
```

Expected: PASS.

**Step 2: Run broader server test suite**

```bash
npm run test -w @unity-shader-nav/server
```

Expected: PASS.

**Step 3: Run build**

```bash
npm run build
```

Expected: PASS.

**Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-24-issue-1-fixplan.md unity-shader-nav/server/src/index/visibility.ts unity-shader-nav/server/src/index/index.ts unity-shader-nav/server/src/index/symbolResolver.ts unity-shader-nav/server/src/index/referenceResolver.ts unity-shader-nav/server/src/index/chainLookup.ts unity-shader-nav/server/src/handlers/definition.ts unity-shader-nav/server/src/handlers/references.ts unity-shader-nav/server/tests/handlers/definition.test.ts unity-shader-nav/server/tests/handlers/references.test.ts
git commit -m "fix(issue-1): bind navigation to include-visible targets"
```

Expected: one commit for issue #1's fix task, per repository discipline.
