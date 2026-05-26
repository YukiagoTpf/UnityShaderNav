# Built-In Shader Vocabulary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement issue #17 by adding a curated built-in Unity/HLSL/ShaderLab completion vocabulary and built-in signature help where parameter metadata exists.

**Architecture:** Add built-ins as a new source under `server/src/suggestions/builtins/` that feeds the shared `ShaderSuggestion` model from #15 and the signature formatter from #16. Keep built-in catalog data separate from handler control flow, and merge built-ins after project suggestions with context filtering.

**Tech Stack:** TypeScript, VS Code Language Server Protocol, `vscode-languageserver`, Vitest, VS Code integration tests.

---

## Prerequisites

- Issue #15 must be merged first.
- Issue #16 must be merged first.
- Read `docs/plans/2026-05-26-shader-completion-roadmap.md`.
- Read `docs/plans/2026-05-26-issue-15-project-symbol-completion.md`.
- Read `docs/plans/2026-05-26-issue-16-signature-help.md`.
- Do not create a `codex/` branch; the repository forbids that prefix.
- Work from repository root `F:\Project\UnityShaderNav`.
- Run npm commands from `F:\Project\UnityShaderNav\unity-shader-nav` unless a task says otherwise.
- For git commands, run from `F:\Project\UnityShaderNav` or use `git -C F:\Project\UnityShaderNav ...`.
- Focused server test filters are relative to the server package, for example `tests/suggestions/builtins/catalog.test.ts`, not `server/tests/...`.

## Design Constraints

- Built-ins are curated, not exhaustive.
- Built-ins must be source/category labeled: `hlsl`, `unitycg`, `urp`, `shaderlab`, or `semantic`.
- Do not add HDRP-specific entries without a fixture, documented need, or follow-up issue.
- Do not fork completion/signature formatting. Use `ShaderSuggestion`, `ShaderParameter`, `toCompletionItem`, and `toSignatureInformation`.
- Project suggestions should sort before built-ins.
- Context filtering matters more than catalog size.

## Task 0: Verify Post-#16 Suggestion API

**Files:**
- Inspect: `unity-shader-nav/server/src/suggestions/types.ts`
- Inspect: `unity-shader-nav/server/src/suggestions/format.ts`
- Inspect: `unity-shader-nav/server/src/suggestions/context.ts`
- Inspect: `unity-shader-nav/server/src/suggestions/projectSymbols.ts`
- Inspect: `unity-shader-nav/server/src/handlers/completion.ts`
- Inspect: `unity-shader-nav/server/src/handlers/signatureHelp.ts`

**Step 1: Verify shared exports**

Confirm the post-#16 code exports equivalents for:

- `ShaderSuggestion`
- `ShaderParameter`
- `toCompletionItem`
- `toSignatureInformation`
- `suggestionContextAt`
- project function collection for signature help

**Step 2: Adapt names locally if needed**

If #15/#16 used slightly different names, adapt this plan's implementation names to the actual exports while preserving the contracts:

- Built-ins feed the shared suggestion model.
- Built-ins use the shared completion and signature formatters.
- Completion handler merges project suggestions before built-ins.
- Signature handler returns `null` when the final signature list is empty.

## Task 1: Add Built-In Catalog Types

**Files:**
- Create: `unity-shader-nav/server/src/suggestions/builtins/types.ts`
- Create: `unity-shader-nav/server/src/suggestions/builtins/index.ts`
- Modify: `unity-shader-nav/server/src/suggestions/index.ts`
- Test: `unity-shader-nav/server/tests/suggestions/builtins/catalog.test.ts`

**Step 1: Write failing catalog type tests**

Add tests that assert:

- A built-in function entry maps to `ShaderSuggestion`.
- A built-in ShaderLab state entry maps to `ShaderSuggestion`.
- Mapped suggestions have `source: 'builtin'`.
- Every catalog entry has a valid category.
- Built-in function parameters use `ShaderParameter`, not indexed `FunctionParameter` ranges.

**Step 2: Run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/builtins/catalog.test.ts
```

Expected: FAIL.

**Step 3: Implement catalog types**

Define:

```ts
export type BuiltinCategory = 'hlsl' | 'unitycg' | 'urp' | 'shaderlab' | 'semantic';

export interface BuiltinEntry {
  name: string;
  kind: 'function' | 'keyword' | 'semantic' | 'state' | 'macro' | 'type';
  category: BuiltinCategory;
  detail?: string;
  documentation?: string;
  insertText?: string;
  returnType?: string;
  parameters?: ShaderParameter[];
}
```

Add `builtinEntryToSuggestion(entry: BuiltinEntry): ShaderSuggestion`.
Use `BUILTIN_ENTRIES satisfies readonly BuiltinEntry[]` for compile-time shape checking once the catalog exists, and add a runtime invariant test over entry categories.

**Step 4: Re-run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/builtins/catalog.test.ts
```

Expected: PASS.

## Task 2: Add The Initial Curated Catalog

**Files:**
- Create: `unity-shader-nav/server/src/suggestions/builtins/catalog.ts`
- Test: `unity-shader-nav/server/tests/suggestions/builtins/catalog.test.ts`

**Step 1: Write failing catalog content tests**

Assert the seed catalog contains:

- HLSL functions: `normalize`, `dot`, `lerp`, `saturate`, `mul`, `tex2D`.
- HLSL scalar/vector types: `float4`, `half4`.
- Unity entries: `UnityObjectToClipPos`, `TRANSFORM_TEX`, `SAMPLE_TEXTURE2D`, `TEXTURE2D`, `SAMPLER`.
- ShaderLab state keywords: `Blend`, `Cull`, `ZWrite`, `ZTest`, `Pass`, `SubShader`.
- Semantics: `POSITION`, `SV_POSITION`, `SV_Target`, `TEXCOORD0`.
- ShaderLab state values: `Off`, `On`, `Back`, `Front`, `Always`, `LEqual`.

Keep assertions light; do not make the test duplicate the whole catalog.

**Step 2: Run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/builtins/catalog.test.ts
```

Expected: FAIL.

**Step 3: Implement catalog**

Create `BUILTIN_ENTRIES: BuiltinEntry[]` with a small high-signal list.

Rules:

- Function entries should include `returnType` and `parameters` when reasonably known.
- HLSL scalar/vector types should use `kind: 'type'` and no `parameters`, so they never produce signature help.
- Macro/keyword/state entries should include concise `detail`.
- Keep docs short. One sentence is enough.
- Every entry must carry `category`.

Suggested function metadata examples:

```ts
{
  name: 'lerp',
  kind: 'function',
  category: 'hlsl',
  returnType: 'T',
  parameters: [
    { type: 'T', name: 'x' },
    { type: 'T', name: 'y' },
    { type: 'T', name: 's' },
  ],
  documentation: 'Linearly interpolates between x and y by s.',
}
```

**Step 4: Re-run catalog tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/builtins/catalog.test.ts
```

Expected: PASS.

## Task 3: Add Built-In Context Filtering

**Files:**
- Create: `unity-shader-nav/server/src/suggestions/builtins/filter.ts`
- Test: `unity-shader-nav/server/tests/suggestions/builtins/filter.test.ts`

**Step 1: Write failing filter tests**

Cover:

- `hlslCode` returns HLSL, UnityCG, and URP entries.
- `semanticPosition` returns semantic entries such as `SV_Target` and `TEXCOORD0`.
- `shaderLabCode` returns ShaderLab state keyword entries.
- `shaderLabStateValue` returns state values such as `Off`, `On`, `Back`, and `LEqual`.
- `comment` returns no entries.
- `string` returns no entries.
- Prefix filtering works for `tex`, `SV_`, `Z`, and `float`.
- Semantic entries are not returned in generic `hlslCode`.
- ShaderLab state values are not returned in generic `shaderLabCode`.
- No HDRP category exists in the initial catalog.

**Step 2: Run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/builtins/filter.test.ts
```

Expected: FAIL.

**Step 3: Implement filtering**

Export:

```ts
export function collectBuiltinSuggestions(
  context: SuggestionContext,
): ShaderSuggestion[];
```

Rules:

- Return empty for comments/strings.
- Extend `SuggestionContextKind` from #15 with coarse built-in contexts: `semanticPosition` and `shaderLabStateValue`.
- Detect `semanticPosition` conservatively when completing after `:` in HLSL/CG code, such as `float4 positionCS : SV_`.
- Detect `shaderLabStateValue` conservatively after known ShaderLab state names, such as `Cull `, `ZWrite `, and `ZTest `.
- For `shaderLabCode`, include only ShaderLab state keywords.
- For `shaderLabStateValue`, include only ShaderLab state values.
- For `hlslCode`, include `hlsl`, `unitycg`, and `urp`.
- For `semanticPosition`, include only `semantic` entries.
- Apply case-sensitive prefix filtering by default. If tests show ShaderLab values need case-insensitive filtering, document and test that explicitly.
- Set `sortText` to place built-ins after project suggestions, for example `9_${entry.name}`.

**Step 4: Re-run filter tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/builtins/filter.test.ts
```

Expected: PASS.

## Task 4: Merge Built-Ins Into Completion

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/completion.ts`
- Modify: `unity-shader-nav/server/src/suggestions/format.ts` if dedupe helper belongs there
- Test: `unity-shader-nav/server/tests/handlers/completion.test.ts`
- Test: `unity-shader-nav/server/tests/suggestions/builtins/filter.test.ts`

**Step 1: Write failing completion handler tests**

Add tests:

- HLSL expression context returns `normalize`.
- ShaderLab outer context returns `Blend`.
- ShaderLab string/comment returns no built-ins.
- Project function named `normalize` collapses duplicate built-in `normalize` in favor of the project symbol.
- Member completion after `surface.` does not add unrelated built-ins.

**Step 2: Run focused tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handlers/completion.test.ts tests/suggestions/builtins/filter.test.ts
```

Expected: FAIL.

**Step 3: Implement merge**

In completion handler:

- Keep existing #15 project suggestions.
- Add `collectBuiltinSuggestions(context)` after project suggestions.
- For member contexts, do not add global built-ins unless a test and design reason requires it.
- Dedupe by completion label/name. Prefer project suggestions over built-ins.
- Preserve real overload-like project functions exactly as #15/#16 already preserve them; only collapse built-in duplicates behind project suggestions.
- Return formatted merged items.

**Step 4: Re-run focused tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handlers/completion.test.ts tests/suggestions/builtins/filter.test.ts
```

Expected: PASS.

## Task 5: Add Built-In Signature Help

**Files:**
- Create or modify: `unity-shader-nav/server/src/suggestions/builtins/signatures.ts`
- Modify: `unity-shader-nav/server/src/handlers/signatureHelp.ts`
- Test: `unity-shader-nav/server/tests/handlers/signatureHelp.test.ts`
- Test: `unity-shader-nav/server/tests/suggestions/builtins/catalog.test.ts`

**Step 1: Write failing signature tests**

Cover:

- `lerp(` returns a built-in signature when no project `lerp` exists.
- Project function `lerp` collapses duplicate built-in `lerp` in favor of the project signature.
- Built-in without parameter metadata does not create a bogus signature.
- Built-ins are not returned in ShaderLab outer context.
- Comments/strings return `null`.
- Final empty signature list returns `null`.

**Step 2: Run focused tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handlers/signatureHelp.test.ts tests/suggestions/builtins/catalog.test.ts
```

Expected: FAIL.

**Step 3: Implement built-in function lookup**

Export:

```ts
export function collectBuiltinFunctionSuggestions(
  name: string,
  context: SuggestionContext,
): ShaderSuggestion[];
```

Rules:

- Only return built-ins where `kind === 'function'`.
- Only return suggestions that have `parameters`.
- Do not return ShaderLab states/macros as signatures.
- Return built-in functions only for `hlslCode`; return `[]` for `shaderLabCode`, `comment`, and `string`.

In `signatureHelp.ts`, merge project function suggestions first, then built-in function suggestions.
Filter `toSignatureInformation` null results and return `null` when the final signature list is empty.
Dedupe exact built-in/project name collisions in favor of project signatures.

**Step 4: Re-run focused tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handlers/signatureHelp.test.ts tests/suggestions/builtins/catalog.test.ts
```

Expected: PASS.

## Task 6: Add VS Code Integration Coverage

**Files:**
- Modify or create: `unity-shader-nav/tests/integration/client/completion-builtins.test.ts`
- Modify or create: `unity-shader-nav/tests/integration/client/signature-help-builtins.test.ts`
- Modify only if needed: `unity-shader-nav/tests/integration/client/fixtures/multi-pass-test.shader`

**Step 1: Write completion integration test**

Assert:

- In `.hlsl` or HLSL block, completion includes `normalize`.
- In ShaderLab outer code, completion includes `Blend`.

**Step 2: Write signature integration test**

Assert:

- `vscode.executeSignatureHelpProvider` on `lerp(` returns a signature containing `lerp`.

**Step 3: Run integration path**

Run:

```powershell
npm test
```

Expected: PASS.

## Task 7: Update Documentation

**Files:**
- Modify: `docs/technical-spec.md`
- Modify: `docs/usage.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.ja.md` if it mirrors feature bullets

**Step 1: Document built-in vocabulary**

Add concise wording:

- Built-in vocabulary is curated and non-exhaustive.
- It includes common HLSL intrinsics, common Unity helper names/macros, common semantics, and common ShaderLab states.
- Project symbols remain preferred when names collide.

**Step 2: Document extension guidance**

Add a short developer note in `docs/technical-spec.md` or `docs/development.md`:

- Add entries through `server/src/suggestions/builtins/catalog.ts`.
- Every entry needs a category.
- Add filter and formatter tests with new categories or behavior.

## Task 8: Final Verification And Commit

**Files:**
- All files changed in this issue.

**Step 1: Run focused server tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server
```

Expected: PASS.

**Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

**Step 3: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

**Step 4: Commit**

Run:

```powershell
git status --short
git add `
  unity-shader-nav/server/src/handlers/completion.ts `
  unity-shader-nav/server/src/handlers/signatureHelp.ts `
  unity-shader-nav/server/src/suggestions `
  unity-shader-nav/server/tests/handlers/completion.test.ts `
  unity-shader-nav/server/tests/handlers/signatureHelp.test.ts `
  unity-shader-nav/server/tests/suggestions `
  unity-shader-nav/tests/integration/client/completion-builtins.test.ts `
  unity-shader-nav/tests/integration/client/signature-help-builtins.test.ts `
  docs/technical-spec.md `
  docs/usage.md `
  README.md `
  README.zh-CN.md `
  README.ja.md
git status --short
git commit -m "feat(issue-17): add built-in shader completion vocabulary"
```

Expected: one commit for issue #17 only.
