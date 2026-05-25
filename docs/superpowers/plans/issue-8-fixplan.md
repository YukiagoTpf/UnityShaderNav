# Issue 8 CG Legacy Variable Declarations Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove and preserve support for CG legacy variable declarations such as `sampler2D`, `fixed4`, and `half` so issue #8 can be handed back for manual validation.

**Architecture:** The current tree-sitter HLSL collector already parses these declarations as top-level `declaration` nodes and indexes them as `variable` symbols with `declaredType`. The issue appears stale rather than a current production-code defect, so the fix is to add issue-specific regression coverage across collector, F12, and Find References without changing the parser/collector path unless RED proves otherwise.

**Tech Stack:** TypeScript, Vitest, VSCode LSP handler tests, `@unity-shader-nav/server`.

---

## Diagnosis

Issue #8 asks for legacy CG declarations to enter the symbol index and support navigation:

```hlsl
sampler2D _MainTex;
fixed4 _Color;
half _Cutoff;
```

Fresh local probes on 2026-05-25 show current `main` already indexes these shapes:

- `sampler2D _MainTex;` becomes `variable:_MainTex:sampler2D`.
- `fixed4 _Color;` becomes `variable:_Color:fixed4`.
- `half _Cutoff;` becomes `variable:_Cutoff:half`.
- The same declarations inside `.shader` `CGPROGRAM` blocks keep correct original-file line offsets.

Root cause for the open issue is therefore not a currently reproducible collector bug in `main`; it is missing issue-specific regression coverage plus a stale GitHub issue state.

## Task 1: Add Issue #8 Regression Coverage

**Files:**
- Modify: `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts`
- Modify: `unity-shader-nav/server/tests/handlers/definition.test.ts`
- Modify: `unity-shader-nav/server/tests/handlers/references.test.ts`

**Step 1: Write failing or acceptance tests**

Add focused tests that assert:

- Collector indexes `sampler2D`, `fixed4`, `half`, and common scalar/vector declarations as `variable` symbols.
- Each symbol has useful `declaredType` metadata.
- F12 on `_MainTex`, `_Color`, and `_Cutoff` usages resolves to their declarations in a `.shader` `CGPROGRAM` block.
- Find References on one declaration returns the declaration plus the usage reference.
- Macro declaration tests continue to pass unchanged by running the existing macro-focused coverage.

**Step 2: Run tests to verify RED or existing GREEN**

Run:

```bash
npm run test -w @unity-shader-nav/server -- tests/parser/hlsl/collector.test.ts tests/handlers/definition.test.ts tests/handlers/references.test.ts tests/macros/integration.test.ts
```

Expected:

- If tests fail, the failure identifies the exact missing production behavior to fix before proceeding.
- If tests pass immediately, document that issue #8 was already fixed by existing collector behavior and this task adds regression coverage.

**Step 3: Implement minimal production fix only if RED identifies a real gap**

If the new tests fail because a declaration shape is not indexed, update `unity-shader-nav/server/src/parser/hlsl/collector.ts` at the declaration collection seam. Keep the fix narrow to declaration shapes proven by the failing test.

If the tests pass immediately, do not change production code.

> Note: During execution on 2026-05-25, the new issue #8 regression tests passed immediately. This confirms the legacy CG declaration behavior already exists on `main`; execution therefore stayed to regression coverage and did not modify production code.

**Step 4: Verify focused behavior**

Run:

```bash
npm run test -w @unity-shader-nav/server -- tests/parser/hlsl/collector.test.ts tests/handlers/definition.test.ts tests/handlers/references.test.ts tests/macros/integration.test.ts
```

Expected: all selected tests pass.

**Step 5: Verify package build**

Run:

```bash
npm run build
```

Expected: build exits 0.

**Step 6: Commit**

```bash
git add docs/superpowers/plans/issue-8-fixplan.md unity-shader-nav/server/tests/parser/hlsl/collector.test.ts unity-shader-nav/server/tests/handlers/definition.test.ts unity-shader-nav/server/tests/handlers/references.test.ts
git commit -m "test(issue-8): cover legacy CG variable declarations"
```

## GitHub Issue Comment Draft

After verification and code review, comment on issue #8 with:

- Diagnosis: current `main` already indexes simple legacy CG declarations; missing piece was explicit issue coverage.
- Files changed.
- Verification commands and outcomes.
- Manual validation request: user should verify in Extension Development Host on a real Unity shader before closing the issue.
