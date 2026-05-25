# Issue 9 Chain Lookup L3b/L4 Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or execute in the main agent with subagent plan/code review gates.

**Goal:** Extend chain lookup so F12 and Find References can resolve struct members through array receivers, nested fields, cbuffer/global struct values, and a narrow RHS call-return inference fallback.

**Root Cause:** Current chain lookup accepts only `identifier.member`. `memberAccessAt()` and `collector.receiverName()` drop non-identifier receivers such as `lights[i]` and `surface.brdfData`, while `inferReceiverType()` only looks up declared types for direct parameter/local/global names. The existing symbol data already has struct member `declaredType`, function `returnType`, and cbuffer-contained globals, but the resolver does not walk through those facts.

**Architecture:** Introduce a small receiver-chain model at the index layer, not a full type checker. Parse only the member expression to the left of the selected/member reference into steps (`root`, `subscript`, `field`). Resolve the root type through existing parameter/local/global lookup, normalize array/subscript receivers to their element/base declared type, then walk nested struct fields by reading `structMember.declaredType`. Add a narrow assignment fallback for `receiver = MakeStruct(); receiver.member` where `receiver` has no declared type and the visible function return type is known.

**Tech Stack:** TypeScript, Vitest, existing LSP handler tests, tree-sitter-hlsl collector/indexer, `GlobalSymbolIndex`, `IndexStore`.

---

### Task 0: Commit This Reviewed Fix Plan

**Files:**
- Create: `docs/superpowers/plans/2026-05-25-issue-9-fixplan.md`
- Modify: `task_plan.md`
- Modify: `findings.md`
- Modify: `progress.md`

**Step 1: After plan review approval, commit the plan**

```bash
git add docs/superpowers/plans/2026-05-25-issue-9-fixplan.md task_plan.md findings.md progress.md
git commit -m "docs(plans): add issue 9 chain lookup fix plan"
```

Expected: one docs commit before implementation work.

### Task 1: Add Receiver Expression Parsing

**Files:**
- Modify: `unity-shader-nav/server/src/index/wordAt.ts`
- Modify: `unity-shader-nav/server/tests/index/wordAt.test.ts`

**Step 1: Write failing parser tests**

Add tests showing `memberAccessAt()` returns the selected final member plus the full receiver expression text/range for:

```hlsl
lights[i].color
surface.brdfData.roughness
settings.value
```

The receiver for `lights[i].color` should be `lights[i]`; the receiver for `surface.brdfData.roughness` should be `surface.brdfData`.

**Step 2: Run RED**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/index/wordAt.test.ts
```

Expected: FAIL on array/nested receiver expectations.

**Step 3: Implement minimal expression scanning**

Extend `MemberAccess.receiver.text` to allow a balanced, same-line expression to the left of the dot. Keep the existing direct identifier behavior unchanged. The scanner should:

- Walk backward from the selected member's dot.
- Balance `]`, `)`, and `}` while scanning left.
- Stop at statement/operator boundaries such as whitespace before an unrelated token, `=`, `,`, `;`, `return`, or `{`.
- Preserve receiver range for handler origin/debug traces.

Do not try to parse arbitrary multiline expressions.

**Step 4: Run GREEN and commit**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/index/wordAt.test.ts
git add unity-shader-nav/server/src/index/wordAt.ts unity-shader-nav/server/tests/index/wordAt.test.ts
git commit -m "feat(issue-9): parse complex member receivers"
```

### Task 2: Add Chain Type Resolution For Arrays And Nested Fields

**Files:**
- Modify: `unity-shader-nav/server/src/index/chainLookup.ts`
- Modify: `unity-shader-nav/server/tests/index/chainLookup.test.ts`

**Step 1: Write failing chain lookup tests**

Add tests for:

```hlsl
Light lights[4]; lights[i].color
Surface surface; surface.brdfData.roughness
cbuffer Params { Settings settings; }; settings.value
```

Use `resolveMember()` directly with receiver strings from Task 1:

- `resolveMember(..., "lights[i]", "color", ...)` targets `Light.color`.
- `resolveMember(..., "surface.brdfData", "roughness", ...)` targets `Brdf.roughness`.
- `resolveMember(..., "settings", "value", ...)` targets `Settings.value`.

Also keep existing L1/L2/L3a tests unchanged.

**Step 2: Run RED**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/index/chainLookup.test.ts
```

Expected: FAIL for array and nested receivers; cbuffer struct may already pass if collected as a global variable, but keep the test as acceptance coverage.

**Step 3: Implement receiver-chain type inference**

Add helpers in `chainLookup.ts`:

- Parse receiver expression into root identifier and field steps. Treat subscript expressions as no-op type steps on the root or field type.
- Reuse existing parameter/local/global lookup for root identifier type.
- For each field step, find a `structMember` where `parentType === currentType` and `name === field`, then advance to that member's `declaredType`.
- For the final requested member, return only `structMember` entries whose `parentType === finalReceiverType`.

Keep visibility filtering through `ResolutionOptions.visibleUriKeys`.

**Step 4: Run GREEN and commit**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/index/chainLookup.test.ts
git add unity-shader-nav/server/src/index/chainLookup.ts unity-shader-nav/server/tests/index/chainLookup.test.ts
git commit -m "feat(issue-9): infer array and nested member receivers"
```

### Task 3: Add Narrow RHS Call Return Inference

**Files:**
- Modify: `unity-shader-nav/shared/src/symbols.ts`
- Modify: `unity-shader-nav/shared/src/cache.ts`
- Modify: `unity-shader-nav/server/src/parser/hlsl/collector.ts`
- Modify: `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts`
- Modify: `unity-shader-nav/server/src/cache/cacheStore.ts`
- Modify: `unity-shader-nav/server/tests/cache/cacheStore.test.ts`
- Modify: `unity-shader-nav/server/src/index/chainLookup.ts`
- Modify: `unity-shader-nav/server/tests/index/chainLookup.test.ts`

**Step 1: Write failing collector/cache tests**

Add non-symbol assignment metadata to `FileIndex`, not to `SymbolEntry`:

```typescript
export interface TypeInferenceEntry {
  receiver: string;
  callName: string;
  assignmentRange: Range;
  scope?: string;
  scopeRange?: Range;
}

export interface FileIndex {
  uri: string;
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
  typeInferences?: TypeInferenceEntry[];
  structure?: StructureResult;
}
```

The collector should populate `typeInferences` only when it sees a direct assignment shape:

```hlsl
surface = MakeSurface();
surface.positionWS;
```

The collector test should verify the metadata can associate `surface` with `MakeSurface`, the assignment range, and the containing function scope before the member use. Do not add inferred type fields to `SymbolEntry`; symbols model declarations, while this metadata models assignment facts.

Update cache schema/version tests so stale cache without this metadata is rejected by bumping `CACHE_VERSION` in `unity-shader-nav/shared/src/cache.ts`. Add a cache test rejecting pre-RHS-inference manifests and validating well-formed `typeInferences`.

**Step 2: Run RED**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/parser/hlsl/collector.test.ts tests/cache/cacheStore.test.ts tests/index/chainLookup.test.ts
```

Expected: FAIL on missing RHS-call inference metadata, cache version validation, or resolution.

**Step 3: Implement the narrow fallback**

Implementation constraints:

- Only infer from direct `identifier = CallName(...)` before the member reference position and inside the same function `scopeRange`.
- Pick the nearest matching assignment before `refPos` in the same function scope.
- Resolve `CallName` through visible function symbols and use `FunctionSymbolEntry.returnType` only when there is exactly one visible function candidate. Bail on zero or multiple candidates.
- Do not infer through ternaries, overloaded calls, nested assignments, constructor-like casts, or macro calls.
- Prefer explicit `declaredType` over inferred RHS type whenever both exist.

**Step 4: Run GREEN and commit**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/parser/hlsl/collector.test.ts tests/cache/cacheStore.test.ts tests/index/chainLookup.test.ts
git add unity-shader-nav/shared/src/symbols.ts unity-shader-nav/shared/src/cache.ts unity-shader-nav/server/src/parser/hlsl/collector.ts unity-shader-nav/server/tests/parser/hlsl/collector.test.ts unity-shader-nav/server/src/cache/cacheStore.ts unity-shader-nav/server/tests/cache/cacheStore.test.ts unity-shader-nav/server/src/index/chainLookup.ts unity-shader-nav/server/tests/index/chainLookup.test.ts
git commit -m "feat(issue-9): infer receiver type from call assignment"
```

### Task 4: Wire Complex Receivers Into Definition And References

**Files:**
- Modify: `unity-shader-nav/server/src/parser/hlsl/collector.ts`
- Modify: `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts`
- Modify: `unity-shader-nav/server/src/index/referenceResolver.ts`
- Modify: `unity-shader-nav/server/tests/index/referenceResolver.test.ts`
- Modify: `unity-shader-nav/server/tests/handlers/definition.test.ts`
- Modify: `unity-shader-nav/server/tests/handlers/references.test.ts`

**Step 1: Write failing handler/reference tests**

Add LSP-boundary tests for F12 on:

- `lights[i].color`
- `surface.brdfData.roughness`
- `settings.value` where `settings` is declared inside a cbuffer
- `surface.positionWS` after `surface = MakeSurface()`

Add reference tests that member references are still filtered by resolved receiver type for array/nested receivers.

**Step 2: Run RED**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/handlers/definition.test.ts tests/handlers/references.test.ts tests/index/referenceResolver.test.ts tests/parser/hlsl/collector.test.ts
```

Expected: FAIL where complex receivers are not recorded or resolved.

**Step 3: Implement collector/reference wiring**

Update `collector.receiverName()` into a receiver-expression extractor so member `ReferenceEntry.receiver` stores the same expression string shape as `memberAccessAt()`. Ensure cache validation accepts the richer string unchanged.

**Step 4: Run GREEN and commit**

```bash
npm run test -w @unity-shader-nav/server -- --run tests/handlers/definition.test.ts tests/handlers/references.test.ts tests/index/referenceResolver.test.ts tests/parser/hlsl/collector.test.ts
git add unity-shader-nav/server/src/parser/hlsl/collector.ts unity-shader-nav/server/tests/parser/hlsl/collector.test.ts unity-shader-nav/server/src/index/referenceResolver.ts unity-shader-nav/server/tests/index/referenceResolver.test.ts unity-shader-nav/server/tests/handlers/definition.test.ts unity-shader-nav/server/tests/handlers/references.test.ts
git commit -m "feat(issue-9): wire complex chain lookup handlers"
```

### Task 5: Document Unsupported Chain Shapes And Verify

**Files:**
- Modify: `docs/superpowers/plans/2026-05-25-issue-9-fixplan.md`
- Modify: `docs/superpowers/PROGRESS.md`
- Modify as needed: `README.md`

**Step 1: Document intentionally unsupported shapes**

Add a note to this plan and, if user-facing enough, README:

- Multiline receiver expressions.
- Macro-expanded receivers.
- Ternary/branch-dependent receiver types.
- Overload-aware return type selection.
- Pointer/reference-like syntax not present in ordinary Unity HLSL.

> Note: 2026-05-25 implementation documents the supported #9 shapes as array element receivers, nested struct fields, cbuffer/global struct values, and narrow direct call-assignment inference. Unsupported shapes are intentionally bounded to keep chain lookup a lightweight resolver rather than a full HLSL type checker.

**Step 2: Run final verification**

```bash
npm run test -w @unity-shader-nav/server
npm run build
```

Expected: PASS.

**Step 3: Commit docs/progress**

```bash
git add docs/superpowers/plans/2026-05-25-issue-9-fixplan.md docs/superpowers/PROGRESS.md README.md
git commit -m "docs(issue-9): record chain lookup support boundaries"
```

### Task 6: Review And GitHub Issue Update

**Files:**
- Create: `docs/superpowers/plans/2026-05-25-issue-9-review.md`
- Create: `docs/superpowers/plans/2026-05-25-issue-9-fixreview.md`

**Step 1: Dispatch final code-review subagent**

Review scope should include all commits after the fix-plan commit. Ask for Critical/Important/Minor findings against issue #9 acceptance criteria and regression risk.

**Step 2: Fix accepted findings**

Use `receiving-code-review`: verify each finding against the codebase, fix Critical/Important items, rerun focused tests, and record disposition in `2026-05-25-issue-9-fixreview.md`.

**Step 3: Final verification**

```bash
npm run test -w @unity-shader-nav/server
npm run build
git status --short
```

Expected: tests/build pass; only intentional docs/source changes are present before final commit.

**Step 4: Commit review artifacts and accepted fixes**

```bash
git add docs/superpowers/plans/2026-05-25-issue-9-review.md docs/superpowers/plans/2026-05-25-issue-9-fixreview.md
git add unity-shader-nav/server/src unity-shader-nav/server/tests unity-shader-nav/shared/src docs/superpowers/PROGRESS.md README.md
git commit -m "fix(issue-9): address chain lookup review findings"
```

If the code review finds no accepted code fixes, commit only the review artifacts and progress update:

```bash
git add docs/superpowers/plans/2026-05-25-issue-9-review.md docs/superpowers/plans/2026-05-25-issue-9-fixreview.md docs/superpowers/PROGRESS.md
git commit -m "docs(issue-9): record chain lookup code review"
```

**Step 5: Comment on GitHub issue #9, do not close**

Post a comment containing:

- Root cause summary.
- Implemented chain shapes.
- Unsupported chain shapes.
- Test/build results.
- Commit SHAs.
- Request for user verification before closing.

---

## Acceptance Checklist

- [x] Failing tests were observed before each production behavior change.
- [x] Array receivers resolve by element/base receiver type: `lights[i].color`.
- [x] Nested fields resolve by walking struct member declared types: `surface.brdfData.roughness`.
- [x] Cbuffer/global struct values resolve through existing global variable collection: `settings.value`.
- [x] RHS call assignment inference works only for the documented narrow shape.
- [x] Existing parameter, local, and file/global receiver behavior remains covered.
- [x] Find References still filters struct members by resolved receiver type.
- [x] Unsupported shapes are documented.
- [ ] GitHub issue #9 is updated but left open for user verification.
