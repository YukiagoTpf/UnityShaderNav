# analyzeCursor() Seam (#26) + referenceMatching Relocation (#27) Implementation Plan

> **For the executor:** Implement task-by-task. After each numbered Task that the issues treat as a discrete unit, run the listed verification and make the commit specified in *Commit guidance*. #26 and #27 are independent concerns and **must land as separate commits**.

**Goal:** Collapse the duplicated cursor-lexical analysis (#26) behind a single `analyzeCursor()` seam in `server/src/parser/lexical/`, with the four existing public entry points (`wordAt`, `memberAccessAt`, `suggestionContextAt`, `isGenericDefinitionContext`) preserved as thin derivations so **no handler changes are required**; and relocate `handlers/referenceMatching.ts` into `index/` where its symbol-resolution helpers belong (#27).

**Architecture:** The two issues touch disjoint file sets and have no ordering dependency between them. #26 is a *internal* consolidation: extract one canonical copy of each shared lexical primitive into a new `parser/lexical/cursor.ts`, build `analyzeCursor()` on top, and re-express the four public functions in terms of the shared pieces — **preserving every public signature and import path**. The handler-side `switch (CursorTarget)` rewrite and `include-path`/`generic-type-arg` classifications are explicitly deferred to #30 (which is blocked by #26). #27 is a mechanical `git mv` plus import rewiring; behavior is unchanged.

**Tech Stack:** TypeScript (ESM, `server/` workspace), Vitest unit tests + VS Code Electron integration tests, npm workspaces. All commands run from `unity-shader-nav/`.

---

**Plan-authoring commit guidance:** When writing/reviewing *this plan document only*, commit just this file with `docs(issue-26): plan analyzeCursor seam and referenceMatching move`. The implementation commits (Part A, Part B) are for the future executor and are described in each part's *Commit guidance*.

---

## 0. Pre-flight: verified facts (already established — re-confirm before editing)

These were verified against the tree on 2026-05-29. Re-run the greps if the code has moved.

### Public surface (what callers actually import)
| Symbol | Home file | Caller import path | External callers |
|---|---|---|---|
| `wordAt` | `index/wordAt.ts` | `'../index'` barrel | `index/referenceResolver.ts`, `handlers/{hover,definition,documentHighlight,references}.ts` |
| `memberAccessAt` | `index/wordAt.ts` | `'../index'` barrel | `index/referenceResolver.ts`, `handlers/{hover,definition,documentHighlight}.ts` |
| `suggestionContextAt` | `suggestions/context.ts` | `'../suggestions'` barrel (`export * from './context'`) | `handlers/{completion,signatureHelp}.ts` |
| `isGenericDefinitionContext` | `parser/lexical/context.ts` | `'../parser/lexical/context'` (direct) | `handlers/{hover,definition,documentHighlight}.ts` |
| types `WordAt`,`MemberAccess` | `index/wordAt.ts` | `'../index'` barrel | (no external type importers found) |
| types `SuggestionContext`,`SuggestionContextKind`,`CompletionPrefix` | `suggestions/context.ts` | `'../suggestions'` barrel | `suggestions/builtins/{filter,signatures}.ts` import `SuggestionContext` |

**Consequence:** Keep these six exports' names, signatures, and import paths intact and **no handler or builtins file needs editing for #26.**

> Note on the "import path" column: it describes *production* callers. The unit tests import some symbols **directly** from the deep path, not the barrel — e.g. `wordAt.test.ts:2`, `index/integration.test.ts:4`, `macros/integration.test.ts:6` import `wordAt`/`memberAccessAt` from `'../../src/index/wordAt'`. The thin re-export in Task A1 resolves these transparently (re-exports are transparent to importers), so no test import path changes — but the executor must keep `index/wordAt.ts` as a real module path, not delete it.

### Private helpers (NOT exported anywhere — confirmed no external leaks)
`lexicalContextAt`, `memberContextAt`, `isSemanticPosition`, `isShaderLabStateValuePosition`, `receiverExpressionStart`, `emptyPrefix`, `prefixAtLine`, `isShaderLabDocument`, `isInsideShaderLabHlslBlock`. The issue's phrase "all callers of `lexicalContextAt`/`memberContextAt` go through `analyzeCursor`" therefore means **internal** consolidation, not external caller migration.

### Existing tests that act as the behavior-preservation guard (must pass unchanged)
- `server/tests/index/wordAt.test.ts` — `wordAt`, `memberAccessAt` (incl. nested parens/brackets, `lights[i].color`).
- `server/tests/suggestions/context.test.ts` — `suggestionContextAt` classification + prefix + member.
- `server/tests/suggestions/callContext.test.ts` — comment/string contexts via `suggestionContextAt`.
- `server/tests/suggestions/builtins/filter.test.ts` — `SuggestionContext`-driven filtering.
- `server/tests/suggestions/memberContext.test.ts` — member receiver completion.
- `server/tests/handlers/definition-properties.test.ts` — the **only** test exercising `isGenericDefinitionContext` (indirectly + 3 direct calls at lines ~216–220).
- `server/tests/index/integration.test.ts`, `server/tests/macros/integration.test.ts` — use `wordAt`.
- `server/tests/handlers/{references,documentHighlight}.test.ts` — exercise the referenceMatching helpers (relevant to #27).

> ⚠️ There is **no dedicated unit test for `parser/lexical/context.ts`** today (the Explore pass that claimed `tests/parser/lexical/context.ts` was wrong — that file does not exist). Task A4 adds the first direct coverage.

### Cycle check (do before committing #26 and #27)
Use the typecheck as the cycle guard: `npm run build` (or `npx tsc --noEmit -p server/tsconfig.json`) before and after — a new circular import surfaces as a type/resolution error. (Do **not** rely on `madge`; it is not a project dependency and `npx madge` would attempt a failing network install.)

**Actual dependency facts (verified 2026-05-29 — the earlier "index→parser already exists" framing was wrong):**
- Today `index/` imports **nothing** from `parser/`. The `index/wordAt.ts` re-export of `parser/lexical/cursor.ts` in Task A1 **creates the first `index → parser` edge.** That is safe (see below), but it is a new edge, not a pre-existing one.
- `parser/` is **not** import-free of `suggestions/`: `parser/shaderlab/tokenScanner.ts:3` already imports `BUILTIN_ENTRIES` from `suggestions/builtins/catalog`. That chain dead-ends in `builtins/catalog → ./types` and never reaches `suggestions/context.ts` or the new `cursor.ts`, so it cannot close a loop.
- The new `cursor.ts`'s only intra-`parser` dependency is `scanBlocks` from `parser/shaderlab/blockScanner`, which imports only `@unity-shader-nav/shared` (a leaf). So `cursor.ts` is itself a leaf within `parser/`, and the new `index → parser/lexical/cursor` edge points at a leaf — acyclic. The invariant to preserve: nothing under `parser/lexical/` may import from `index/` or `suggestions/`.

---

## Discrepancies between the issues and the actual code (carry into the issue threads)

1. **#26 "byte-identical copy" is inaccurate.** `receiverExpressionStart` in `index/wordAt.ts:84` and `suggestions/context.ts:123` are *behaviorally* identical but textually differ: `wordAt.ts` names an intermediate `const insideBalancedGroup = …`; `context.ts` inlines the condition. The deletion test still holds (one copy must remain) — just don't expect a literal byte match.
2. **#26 understates the duplication.** Besides `receiverExpressionStart`, `lexicalContextAt`, `isShaderLabDocument`, and `isInsideShaderLabHlslBlock` are *also* duplicated between `parser/lexical/context.ts` and `suggestions/context.ts`, and the `ID_CHAR_RE`/`ID_START_RE` regexes are duplicated in `wordAt.ts` and `suggestions/context.ts`. This plan dedups all of them.
3. **#26 CursorContext shape is aspirational.** Its provisional `classification` lists `include-path` and `generic-type-arg`. Neither exists in today's code: include detection lives in handler-level `scanIncludes` (that is #30's job), and `isGenericDefinitionContext` is just "HLSL-region code". This plan keeps `analyzeCursor`'s classification == the current `SuggestionContextKind` set and **defers `include-path`/`generic-type-arg` to #30**, matching the dependency graph (#30 is blocked by #26).
4. **#27 lists 8 exports; the file actually exports 10.** `sameRange` and `containsPosition` are also `export`ed but used only internally. The move must carry all 10. A *separate* private `containsPosition` exists in `index/referenceResolver.ts:37` — after the move both live under `index/`; this is fine (different files, only one is barrel-exported) but note it to avoid confusion.
5. **#27 importers / barrel.** Only 2 files import the helpers (`handlers/documentHighlight.ts`, `handlers/references.ts`), both via `'./referenceMatching'`. No test imports it. There is **no `handlers/index.ts` barrel**. The moved file imports `ReferenceTarget` from the `'../index'` barrel — this must be rewired to `'./referenceResolver'` after the move (importing the barrel from inside `index/` risks a cycle and is wrong locality).
6. **CONTEXT.md location.** It lives at the **outer repo root** `/Users/bytedance/Project/UnityShaderNav/CONTEXT.md`, not under `unity-shader-nav/`. The "Suggestion context" entry is in the `### 补全与签名` section; "PackageResolver" is in `### 索引生命周期`.

---

# Part A — #26: analyzeCursor() unified cursor lexical seam

### Target module layout

**New file `server/src/parser/lexical/cursor.ts`** becomes the single home for:
- Regexes: `ID_CHAR_RE`, `ID_START_RE`.
- Types: `WordAt`, `MemberAccess`, `LexicalContext`, `CompletionPrefix`, `SuggestionContextKind`, and the new `CursorContext`.
- Word/member primitives: `receiverExpressionStart` (the **single** canonical copy), `wordAt`, `memberAccessAt`.
- Lexical primitives: `lexicalContextAt`, `isShaderLabDocument`, `isInsideShaderLabHlslBlock` (imports `scanBlocks` from `../shaderlab/blockScanner`).
- Prefix/classification helpers: `emptyPrefix`, `prefixAtLine`, `memberContextAt`, `isSemanticPosition`, `isShaderLabStateValuePosition`, `SHADERLAB_STATE_VALUE_CONTEXTS`.
- Composition entry points:
  - `classifyCursor(text, pos, languageId, uri): { classification: SuggestionContextKind; lexical: LexicalContext; prefix: CompletionPrefix; member?: SuggestionContext['member'] }` — the lexical+classification core (everything `suggestionContextAt` does today).
  - `analyzeCursor(text, pos, languageId, uri): CursorContext` — composes `classifyCursor` **plus** `wordAt`/`memberAccessAt`.

```ts
export interface CursorContext {
  word: WordAt | null;            // wordAt semantics (off-identifier → null)
  member: MemberAccess | null;    // memberAccessAt semantics (navigation receiver/member)
  lexical: LexicalContext;        // 'code' | 'comment' | 'string'
  classification: SuggestionContextKind; // existing 6 kinds — NO include-path/generic-type-arg (see #30)
  prefix: CompletionPrefix;       // completion prefix (prefixAtLine semantics)
  memberPrefix?: SuggestionContext['member']; // completion member context (receiver + memberPrefix)
}
```

> **Behavior-preservation rule:** `analyzeCursor` must compute each field with the *existing* algorithm for that field — it is a superset, not a re-interpretation. `word` uses `wordAt` semantics; `prefix` uses `prefixAtLine` semantics (empty at a dot); they are **not** merged. The four public wrappers below each invoke only the sub-computation they used before, so navigation paths do **not** newly pay for completion-only work.

### Task A1 — Extract primitives + move `wordAt`/`memberAccessAt` into `cursor.ts`; delete duplicates

**Files:**
- Create: `server/src/parser/lexical/cursor.ts`
- Edit: `server/src/index/wordAt.ts` → becomes a thin re-export
- Edit: `server/src/suggestions/context.ts` → delete its private `receiverExpressionStart`, `lexicalContextAt`, `isShaderLabDocument`, `isInsideShaderLabHlslBlock`, `ID_CHAR_RE`, `ID_START_RE` copies; import from `cursor.ts`
- Edit: `server/src/parser/lexical/context.ts` → delete its private `lexicalContextAt`, `isShaderLabDocument`, `isInsideShaderLabHlslBlock` copies; import from `cursor.ts`

**Steps:**
1. Author `cursor.ts` with the regexes, types, `receiverExpressionStart` (pick the `wordAt.ts` variant with the named `insideBalancedGroup` — it is the more readable of the two equivalents), `wordAt`, `memberAccessAt`, and the lexical primitives. Export `wordAt`, `memberAccessAt`, types; keep the rest module-private for now (exported only as needed by Task A2).
2. Replace `server/src/index/wordAt.ts` body with:
   ```ts
   export { wordAt, memberAccessAt } from '../parser/lexical/cursor';
   export type { WordAt, MemberAccess } from '../parser/lexical/cursor';
   ```
   (`index/index.ts` barrel line 11/16 already re-export from `./wordAt`, so the barrel and every handler import keep working untouched.)
3. In `suggestions/context.ts` and `parser/lexical/context.ts`, delete the now-duplicated private helpers and import the canonical ones from `../parser/lexical/cursor`. Leave `suggestionContextAt` / `isGenericDefinitionContext` bodies behaviorally identical for now (they will be re-expressed in A2).

**Verify:** `npm run build` typechecks; `npm test` green. Grep proves the dedup: `grep -rn "function receiverExpressionStart" server/src` → exactly **one** hit (`cursor.ts`); same single-hit check for `function lexicalContextAt`, `function isShaderLabDocument`, `function isInsideShaderLabHlslBlock`.

### Task A2 — Build `analyzeCursor()` and re-express the public entry points

**Files:**
- Edit: `server/src/parser/lexical/cursor.ts` (add `classifyCursor` + `analyzeCursor` + `CursorContext`)
- Edit: `server/src/suggestions/context.ts` (`suggestionContextAt` → derive from the shared core)
- Edit: `server/src/parser/lexical/context.ts` (`isGenericDefinitionContext` → derive from the shared core)

**Steps:**
1. In `cursor.ts`, factor the body of the old `suggestionContextAt` into `classifyCursor(...)` returning `{ classification, lexical, prefix, member }`. Add `analyzeCursor(...)` = `classifyCursor(...)` + `wordAt` + `memberAccessAt` assembled into `CursorContext`. Keep `SuggestionContext`/`SuggestionContextKind`/`CompletionPrefix` exported from `suggestions/context.ts` (re-export the type from `cursor.ts` if you move its definition, so `builtins/{filter,signatures}.ts` imports stay valid).
2. Re-express `suggestionContextAt(text,pos,lang,uri)` as: `const c = classifyCursor(...); return { kind: c.classification, prefix: c.prefix, member: c.member };` — identical output shape to today.
   **Field-shape caveat (must honor):** today `suggestionContextAt` returns `{ kind, prefix }` with **no `member` key** when `lexical !== 'code'` (`suggestions/context.ts:242`), and `{ kind, prefix, member }` (where `member` may be `undefined`) in the code branch. `classifyCursor` must therefore return `member: undefined` in the non-code branch (not a missing key), and `suggestionContextAt`'s spread must produce a shape that `context.test.ts` accepts. Because `member?` is optional, `{ member: undefined }` is type-compatible and the consumer truthiness checks (`completion.ts` `context.member`, `signatureHelp.ts`) behave identically — but if any existing assertion uses `toEqual` on the full object, present-`undefined` vs absent could differ. **A2 must run `context.test.ts` and `callContext.test.ts` and, if a `toEqual` shape assertion trips, normalize by omitting the `member` key when undefined.**
3. Re-express `isGenericDefinitionContext(text,pos,lang,uri)` by keeping its **current body verbatim** and only swapping its now-deduplicated helper imports to `../parser/lexical/cursor` (`lexicalContextAt`, `isShaderLabDocument`, `isInsideShaderLabHlslBlock`). Do **not** route it through `classifyCursor` — that would make it newly compute `prefixAtLine`/`memberContextAt`/`isSemanticPosition`, work it does not do today. Staying on the three lean primitives literally preserves its current cost and is itself a "narrower derived helper" per the AC.
   Record as a code comment the *verified* equivalence (a cross-check, not the implementation): `isGenericDefinitionContext(...) === (classifyCursor(...).classification ∈ {'hlslCode','semanticPosition'})`, because the old body returns `inHlslContext && lexical==='code'` and that set is exactly `baseKind==='hlslCode' && lexical==='code'`. The review independently traced both paths and found no counterexample; `definition-properties.test.ts` (lines ~216–220) is the pin.
4. `wordAt`/`memberAccessAt` stay as the lean primitives (no `scanBlocks`); they are the "narrower derived helpers" the issue's AC allows.

**Verify:** `npm test` green (this is the equivalence proof — `definition-properties.test.ts` pins `isGenericDefinitionContext`; `context.test.ts`/`callContext.test.ts`/`filter.test.ts` pin `suggestionContextAt`; `wordAt.test.ts` pins word/member).

### Task A3 — Table-driven `analyzeCursor` unit tests

**Files:** Create `server/tests/parser/lexical/analyzeCursor.test.ts`

**Steps:** Table-driven cases covering at minimum (per #26 AC): plain identifier, member access with nested parens/brackets (`lights[i].color.x`), include-path-looking text (assert it is treated as ordinary code in #26 — no `include-path` kind yet; leave a `// #30` note), semantic position (`float4 c : SV_Target`), ShaderLab state value (`Blend One`), comment, string, and generic-type argument context. Assert `word`, `member`, `classification`, `prefix`, `memberPrefix` per case. Add at least one `.shader` ShaderLab-vs-HLSL-block case to lock the `isInsideShaderLabHlslBlock` gating.

**Verify:** new file passes; full suite green.

### Task A4 — CONTEXT.md glossary update

**Files:** Edit `/Users/bytedance/Project/UnityShaderNav/CONTEXT.md` (outer repo root)

**Steps:**
1. Add a new **Cursor context** term (place it just before **Suggestion context** in `### 补全与签名`, or in `### 跳转行为` since it now also feeds navigation — author's call; keep the `**Term**:` + description + `_Avoid_:` format):
   > **Cursor context**:
   > 由 `analyzeCursor()` 统一产出的"光标处词法信息"结构：当前 word、member access、词法态（code/comment/string）、补全分类（HLSL/ShaderLab/semantic/state-value）和补全前缀。导航（F12/hover/highlight）与补全/签名共用这一份分析，取代过去散落在 `wordAt`/`suggestionContextAt`/`isGenericDefinitionContext` 的三处重复实现。
   > _Avoid_: lexical state, parser context
2. Broaden the existing **Suggestion context** entry to note it is now the completion-facing projection of **Cursor context** (one clause; do not delete the entry — `SuggestionContext` is still a live type).

**Verify:** N/A (docs). Confirm wording matches surrounding entries' style.

### Part A Commit guidance
One commit after A1–A4 pass together: `feat(issue-26): unify cursor lexical analysis behind analyzeCursor()`. (A single feature; the four tasks are not "unrelated".)

---

# Part B — #27: move `referenceMatching` into `index/`

### Task B1 — Relocate file and rewire imports

**Files:**
- Move: `server/src/handlers/referenceMatching.ts` → `server/src/index/referenceMatching.ts` (use `git mv` to preserve history)
- Edit (moved file): change `import type { ReferenceTarget } from '../index';` → `from './referenceResolver';`
- Edit: `server/src/index/index.ts` — add the **8 externally-consumed** functions to the barrel
- Edit: `server/src/handlers/documentHighlight.ts` and `server/src/handlers/references.ts` — change the import source

**Steps:**
1. `git mv server/src/handlers/referenceMatching.ts server/src/index/referenceMatching.ts`.
2. In the moved file, rewire the one cross-package import: `ReferenceTarget` now comes from the sibling `./referenceResolver`. Do **not** change any export keywords (mechanical move — `sameRange`/`containsPosition` stay `export`ed even though only internal; de-exporting them is an optional follow-up, out of scope here).
3. In `index/index.ts`, add a re-export of the 8 helpers actually used outside `index/`:
   `isGlobalKindAwareTarget, isMemberTarget, isReferenceContextCompatible, isScopedTarget, narrowGlobalTargetsForOccurrence, sameTarget, symbolToTarget, uniqueLocations`.
   Do **not** add `sameRange`/`containsPosition` (per #27 AC "re-export only what is consumed outside `index/`").
4. Update both handler imports from `'./referenceMatching'` → `'../index'` (consistent with how they already import `wordAt`/`resolve*` from the barrel — the AC requires "imports the helpers from `index/`, not a sibling handlers path").

**Verify:**
- `grep -rn "referenceMatching" server/src` shows the file under `index/` and **no** `handlers/referenceMatching` import path remains.
- `npm run build` (or `npx tsc --noEmit -p server/tsconfig.json`) reports no new cycle (the `index/referenceMatching → index/referenceResolver` edge is intra-package, type-only, and acyclic; `referenceResolver` does not import `referenceMatching`). Do not use `madge`.
- `npm test` green (no test imports referenceMatching directly, so handler integration tests `references.test.ts`/`documentHighlight.test.ts` are the guard).

### Part B Commit guidance
One commit: `refactor(issue-27): move referenceMatching helpers into index/`.

---

## Sequencing

#26 and #27 are independent (disjoint files; #26 touches `parser/lexical`, `index/wordAt.ts` re-export, `suggestions/context.ts`; #27 touches `index/referenceMatching.ts`, barrel, two handler import lines — and #26 does **not** edit handlers). Either order works. Recommended: **#27 first** (fast, mechanical, de-risks #32) → **#26** → two separate commits. Both unblock downstream work: #27 + #30 feed #32; #26 feeds #30.

## Acceptance-criteria mapping

**#26**
- [ ] `receiverExpressionStart` in exactly one place → Task A1 grep check.
- [ ] Callers go through `analyzeCursor()` or a narrower derived helper → `wordAt`/`memberAccessAt` (lean wrappers), `suggestionContextAt`/`isGenericDefinitionContext` (derive from `classifyCursor`); Task A2.
- [ ] Table-driven `analyzeCursor` tests (identifier, nested-paren member, include path, semantic, state value, comment, string, generic-type-arg) → Task A3.
- [ ] Full vitest passes + manual smoke → see checklist below.
- [ ] CONTEXT.md "Suggestion context" broadened / "Cursor context" added → Task A4.

**#27**
- [ ] File under `server/src/index/` → B1.1.
- [ ] `references.ts` imports from `index/` not handlers/ → B1.4.
- [ ] Barrel re-exports only what is consumed outside `index/` → B1.3 (the 8, not `sameRange`/`containsPosition`).
- [ ] Full vitest passes unchanged → B1 verify.

## Risks & rollback
- **Subtle behavior drift in A2** (the equivalence rewrites). Mitigation: the existing suites are the oracle — do not modify any existing test to make it pass; if one fails, the rewrite is wrong, not the test. Rollback = revert the single `feat(issue-26)` commit.
- **Perf regression on navigation** if `isGenericDefinitionContext`/`wordAt` accidentally start running full `analyzeCursor` (extra `scanBlocks`). Mitigation: A2 routes them through `classifyCursor`/lean primitives only; add a code comment marking the intent.
- **Import cycle** from putting word primitives under `parser/lexical/cursor.ts` and re-exporting via `index/wordAt.ts`. This introduces the *first* `index → parser` edge (today there is none). It is safe because `cursor.ts` is a leaf within `parser/` (its only intra-parser import is the leaf `blockScanner`) and nothing under `parser/lexical/` imports `index/` or `suggestions/`. Mitigation: the typecheck cycle guard in §0 and B1; preserve the "`parser/lexical/` imports neither `index/` nor `suggestions/`" invariant.
- **#27 barrel over-export.** Adding `sameRange`/`containsPosition` to the barrel would violate the AC and widen the public surface. Mitigation: re-export exactly the 8.

## Manual smoke checklist (after both commits, F5 the extension on a representative `.shader`)
- F12 on a plain identifier → jumps to declaration.
- F12 on `surface.color` (member access) → resolves via chain lookup.
- Hover on a member access → shows hover.
- Ctrl+Space in an HLSL block → completions; in a comment/string → none.
- Signature help on a function call → parameters shown.
- Find References on an identifier → declarations + references, deduped.
- Find References on a ShaderLab `_MainTex` property → still bridges to HLSL (guards #27's handler import rewrite).

---

## Review record (2026-05-29)

Reviewed by an adversarial plan-review subagent that re-verified the load-bearing claims against source. **Verdict: APPROVE WITH CHANGES** — applied below.

**Independently confirmed:**
- The highest-risk claim — `isGenericDefinitionContext` ⇔ `classification ∈ {hlslCode, semanticPosition}` — is exactly equivalent; both code paths traced, no counterexample.
- "Zero handler changes for #26" holds (handlers import `wordAt`/`memberAccessAt` from the `'../index'` barrel; `isGenericDefinitionContext` direct from `'../parser/lexical/context'`).
- #27 specifics: 10 exports, exactly 2 importers (both handlers), no test imports, `referenceResolver` does not import `referenceMatching` (move is cycle-safe).
- No build-breaking caller / test / re-export / type import is missed.

**Fixes applied after review:**
1. Cycle guard switched from `madge` (not a project dependency; `npx` would fail) to the `tsc --noEmit` / `npm run build` typecheck.
2. Corrected the dependency-direction facts: there is no pre-existing `index → parser` edge (#26 creates the first one, pointing at the leaf `cursor.ts`); and `parser/` already has a deep `parser/shaderlab/tokenScanner.ts → suggestions/builtins/catalog` edge — the prior "parser imports nothing from suggestions" statement was wrong. Conclusion (cycle-free) unchanged.
3. Pinned `classifyCursor`'s non-code-branch `member` semantics (`member: undefined`) and required `context.test.ts`/`callContext.test.ts` to confirm no `toEqual` shape break.
4. Adopted the reviewer's cleaner suggestion: `isGenericDefinitionContext` keeps its current body on the three lean lexical primitives (not routed through `classifyCursor`), truly preserving navigation-path cost.
5. Clarified that unit tests import `wordAt`/`memberAccessAt` directly from `src/index/wordAt` (the thin re-export resolves transparently; that module path must remain).

**Open caveat:** the subagent could not run `npm run build` / `npm test` in its sandbox (no installed binaries), so the "baseline green" assumption is unverified by review — the executor must run the suite in a properly installed tree.
