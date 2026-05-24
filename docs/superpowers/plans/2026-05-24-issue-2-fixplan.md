# Issue 2 Struct Navigation Regression Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Close issue #2 by locking struct type and struct member navigation behavior with explicit regression tests that match the real reported shader shapes.

**Root Cause:** The current `main` implementation already resolves the reported shapes after the scope-aware navigation work: `resolveDefinitionSymbols()` returns same-file and include-visible struct symbols for type identifiers, and `resolveMemberSymbols()` infers receiver types from parameters, locals, and globals before selecting `structMember` symbols. The remaining issue is coverage drift: there is no dedicated issue #2 acceptance test for `Customdata customdata;`, include-chain struct type lookup, or both `i.positionWS` and `inputData.positionWS` in the same fixture.

> Note: 2026-05-24 real-project verification reopened issue #2. `Assets/Shader/Char_Common.shader` still fails because the HLSL parser can mis-nest a Unity macro-bearing struct body and collect later function-body declarations such as `InputData inputData;` as `v2f` struct members instead of local variables. Add a focused regression and debug trace before changing collector behavior.

**Architecture:** Add handler-level tests at the LSP boundary instead of only unit-level resolver tests. Use real temp files plus `indexFile()`, `IndexStore`, `GlobalSymbolIndex`, and `collectVisibleUriKeys()` through the existing definition handler so the tests exercise parsing, indexing, include visibility, word/member detection, and final `LocationLink` output.

**Tech Stack:** TypeScript, Vitest, VSCode LSP handlers, existing HLSL indexer, `IndexStore`, `GlobalSymbolIndex`, and definition handler fixtures.

---

### Task 0: Commit This Reviewed Fix Plan

**Files:**
- Create: `docs/superpowers/plans/2026-05-24-issue-2-fixplan.md`

**Step 1: Commit the reviewed plan**

```bash
git add docs/superpowers/plans/2026-05-24-issue-2-fixplan.md
git commit -m "docs(plans): add issue 2 struct navigation fix plan"
```

Expected: one docs commit before implementation work, preserving the repository rule that each task has its own commit.

### Task 1: Add Regression Tests For Struct Type Definitions

**Files:**
- Modify: `unity-shader-nav/server/tests/handlers/definition.test.ts`

**Step 1: Add same-file struct type test**

Add a test named `resolves a struct type identifier in a variable declaration` with this HLSL shape:

```hlsl
struct Customdata {
  half3 shadow;
  half midtone;
};

float4 frag() {
  Customdata customdata;
  customdata.midtone = 1;
  return 1;
}
```

Index the file through `indexFile()`, register the definition handler, invoke F12 on the `Customdata` token in `Customdata customdata;`, and assert:

- one `LocationLink`
- `targetRange` equals the `struct Customdata` symbol range
- `originSelectionRange` equals the type token range, not the variable token range

**Step 2: Add variable-token disambiguation assertion**

In the same fixture, invoke F12 on the `customdata` variable token in `Customdata customdata;` and assert:

- one `LocationLink`
- `targetRange` equals the local variable symbol range
- the target is not the `struct Customdata` symbol range

This preserves issue #2's requirement that the type identifier `Customdata` is not confused with the variable identifier `customdata`.

**Step 3: Add include-chain struct type test**

Add a test named `resolves an include-visible struct type identifier in a variable declaration` with real temp files:

- `Assets/Types.hlsl` declares `struct Customdata`
- `Assets/Main.hlsl` includes `Types.hlsl` and declares `Customdata customdata;`

Index both files, seed `store` and `global`, register the definition handler, invoke F12 on `Customdata` in `Main.hlsl`, and assert the target URI/range is the struct declaration in `Types.hlsl`.

**Step 4: Add ShaderLab HLSLPROGRAM include variant**

Add a test named `resolves an include-visible struct type identifier inside a shader hlsl block` with real temp files:

- `Assets/Types.hlsl` declares `struct Customdata`
- `Assets/Main.shader` contains a `Shader` with `HLSLPROGRAM`, `#include "Types.hlsl"`, and a function declaring `Customdata customdata;`

Create the text document with language id `shaderlab`, index both files, seed `store` and `global`, invoke F12 on `Customdata` inside the HLSL block, and assert the target URI/range is the struct declaration in `Types.hlsl`.

**Step 5: Run focused tests**

```bash
npm run test -w @unity-shader-nav/server -- tests/handlers/definition.test.ts -t "struct type identifier"
```

Expected: PASS. If any test unexpectedly fails, first add a `> Note:` to this plan explaining the deviation, then fix production resolver code before continuing.

**Step 6: Commit**

```bash
git add unity-shader-nav/server/tests/handlers/definition.test.ts
git commit -m "test(issue-2): cover struct type navigation"
```

Expected: one commit for the struct type regression task.

### Task 2: Add Regression Tests For Receiver-Typed Struct Members

**Files:**
- Modify: `unity-shader-nav/server/tests/handlers/definition.test.ts`

**Step 1: Add same-fixture member receiver test**

Add a test named `resolves struct members through function parameter and local receivers` with this HLSL shape:

```hlsl
struct Varyings {
  float3 positionWS;
};

struct InputData {
  float3 positionWS;
  float4 shadowCoord;
};

float4 frag(Varyings i) {
  InputData inputData;
  inputData.positionWS = i.positionWS;
  inputData.shadowCoord = float4(i.positionWS, 1);
  return 1;
}
```

Register the definition handler and assert:

- F12 on `i.positionWS` targets `Varyings.positionWS`
- F12 on `inputData.positionWS` targets `InputData.positionWS`
- both returned links use the member token as `originSelectionRange`

**Step 2: Run focused tests**

```bash
npm run test -w @unity-shader-nav/server -- tests/handlers/definition.test.ts -t "struct members through function parameter and local receivers"
```

Expected: PASS. If the parameter or local receiver path fails, first add a `> Note:` to this plan explaining the deviation, then fix `resolveMemberSymbols()` / receiver type collection before continuing.

**Step 3: Commit**

```bash
git add unity-shader-nav/server/tests/handlers/definition.test.ts
git commit -m "test(issue-2): cover receiver typed struct member navigation"
```

Expected: one commit for the member receiver regression task.

### Task 3: Verify, Report, And Close Issue

**Files:**
- No source edits expected unless verification reveals a bug.

**Step 1: Run focused definition tests**

```bash
npm run test -w @unity-shader-nav/server -- tests/handlers/definition.test.ts
```

Expected: PASS.

**Step 2: Run broader server tests**

```bash
npm run test -w @unity-shader-nav/server
```

Expected: PASS.

**Step 3: Run build**

```bash
npm run build
```

Expected: PASS.

**Step 4: Request code review**

Dispatch a code-review subagent with:

- implemented work: issue #2 regression coverage and any production fixes if needed
- plan: this file
- base/head SHAs covering the issue #2 commits

Fix any Critical or Important findings before continuing.

**Step 5: Comment on GitHub issue #2 and close it**

Post a comment summarizing:

- root cause diagnosis
- added regression tests
- verification commands and results
- commit SHAs

Then close issue #2 as completed.
