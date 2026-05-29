# CursorTarget Union + Handler Include-Click Consolidation (#30) Implementation Plan

> **For the executor:** Implement task-by-task. After each numbered Task, run its verification and make the specified commit. All commits are under issue #30. Commands run from `unity-shader-nav/`. Behavior-preservation is the whole game here — the existing handler test suites are the oracle; never edit a test to make it pass.

**Goal:** Lift the "what is the cursor pointing at" decision out of the four navigation handlers (`definition`, `references`, `hover`, `documentHighlight`) into a single `cursorTargetAt()` classifier returning a `CursorTarget` discriminated union, so the include-click decision lives in one place and no handler calls `scanIncludes`/`memberAccessAt`/`wordAt` directly.

**Architecture:** Introduce `CursorTarget = include | member | symbol | none` and `cursorTargetAt(text, position, options?)` in `server/src/index/cursorTarget.ts` (so #32's future `resolveTarget(CursorTarget, ctx)` in `index/` can consume the type without depending on `handlers/`). The classifier is a thin layer over the existing `scanIncludes` (include-click) and `memberAccessAt` (member vs symbol). Each handler becomes a `switch (target.kind)`. Two concerns stay **outside** the classifier to preserve behavior exactly: (1) the `isGenericDefinitionContext` **gate** stays per-handler (definition/hover/documentHighlight gate; references does not); (2) definition's **property bridge** (`propertyAt`) stays a definition-only step (it is not a duplicated decision and needs the index). See "Design decisions" for why.

**Tech Stack:** TypeScript (ESM, `server/` workspace), Vitest unit + VS Code Electron integration tests.

---

**Plan-authoring commit guidance:** When writing/reviewing *this plan document only*, commit just this file: `docs(issue-30): plan CursorTarget union and handler consolidation`.

---

## 0. Pre-flight: verified facts (re-confirm before editing)

Verified against the tree on 2026-05-29 (after #26/#27 landed).

### The four handlers' current "what is under the cursor" prelude

| Handler | include-click | property bridge | member/symbol detection | `isGenericDefinitionContext` gate |
|---|---|---|---|---|
| `definition.ts` | YES — `scanIncludes` + inline pathRange check (59–63), then `resolveInclude`+jump | YES — `propertyAt(idx,pos)` forward bridge (117), runs **before** the gate; plus a **reverse** `findPropertyCandidatesForName` in the symbol path (215) | `memberAccessAt` (167) + `wordAt` (193), direct | YES (154), **after** property, before member/symbol |
| `references.ts` | YES — `scanIncludes` + local `includePathContainsPosition` (53), then "who-includes-this-header" walk | no | `wordAt` (94) for null-check + queryName fallback; member/symbol split is **internal** to `resolveReferenceTargets` | **NO gate** |
| `hover.ts` | no (returns null on includes via the gate) | no | `memberAccessAt` (50) + `wordAt` (51,88), direct | YES (44), first |
| `documentHighlight.ts` | no (skips `include`-context refs) | no | `wordAt` (148) + `memberAccessAt` (157), direct | YES (139), first |

### Types (exact names)
- `IncludeDirective { path: string; pathRange: Range; line: number }` — `parser/include/lineScanner.ts` (the issue called this `IncludeReference`; the real name is **`IncludeDirective`**). `scanIncludes(text): IncludeDirective[]` strips comments, so an `#include` inside a comment is not detected.
- `ShaderLabPropertyEntry` — `@unity-shader-nav/shared`; `propertyAt(idx, position): ShaderLabPropertyEntry | null` (`index/propertyBridge.ts`).
- `ResolvedInclude { absolutePath; via; caseInsensitive }` — `include/types.ts`; `resolveInclude(path, fromUri, includeCtx)` is **async**.
- `WordAt`, `MemberAccess` — `parser/lexical/cursor.ts` (re-exported from `index/`). `memberAccessAt` returns `null` iff `wordAt` is null; `ma.member` IS the `wordAt` result; `ma.receiver` is non-null only for `recv.member` access.

### Regression guards (must stay green, unedited)
`tests/handlers/definition.test.ts`, `definition-include.test.ts`, `definition-properties.test.ts`, `hover.test.ts`, `documentHighlight.test.ts`, `references.test.ts`. Current baseline: **607 pass / 1 skip**.

---

## Design decisions (the load-bearing choices — challenge these in review)

1. **The union is `include | member | symbol | none` — no `property` kind.** The issue's illustrative union lists `property`, but property detection (a) needs the index (`propertyAt`), not just text, (b) is **definition-only** and therefore not a duplicated decision (the AC targets the *include-click* duplication), and (c) folding it in would force idx-threading and break the "include is detected before idx is loaded" ordering definition relies on. So property stays definition's existing `propertyAt` step, untouched. **Deviation from the issue's sketch — flagged for review.**

2. **The `isGenericDefinitionContext` gate stays in the handlers, not in the classifier.** references.ts deliberately does **not** gate (Find References resolves an identifier even in a comment). Baking the gate into `cursorTargetAt` would regress references. So `cursorTargetAt` answers only "what token is under the cursor"; each handler keeps applying the gate exactly where it does today (definition/hover/documentHighlight gate member/symbol; references doesn't). Handlers may still call `isGenericDefinitionContext` — the AC only forbids direct `scanIncludes`/`memberAccessAt` calls.

3. **`cursorTargetAt(text, pos, { detectIncludes = true })`.** Only definition and references navigate includes, and only they should pay `scanIncludes`. hover and documentHighlight are latency-sensitive and today never scan includes (they gate-first; include paths sit inside strings → gate already returns false → null). They will pass `detectIncludes: false`, keeping their hot path free of `scanIncludes` while still consuming a `CursorTarget`. This preserves both behavior (still null on includes via the gate) and perf. **Alternative considered:** always detect includes (simpler API, but adds an O(text) `scanIncludes` to every hover/highlight for zero functional gain). Recommend the flag; reviewer to confirm.

### The classifier
```ts
// server/src/index/cursorTarget.ts
import type { Position } from '@unity-shader-nav/shared';
import { scanIncludes, type IncludeDirective } from '../parser/include/lineScanner';
import { memberAccessAt, type WordAt } from './wordAt';

export type CursorTarget =
  | { kind: 'include'; include: IncludeDirective }
  | { kind: 'member';  receiver: WordAt; member: WordAt }
  | { kind: 'symbol';  word: WordAt }
  | { kind: 'none' };

export interface CursorTargetOptions { detectIncludes?: boolean }

export function cursorTargetAt(
  text: string,
  position: Position,
  options: CursorTargetOptions = {},
): CursorTarget {
  const { detectIncludes = true } = options;
  if (detectIncludes) {
    const include = scanIncludes(text).find((d) =>
      d.line === position.line
      && position.character >= d.pathRange.start.character
      && position.character <= d.pathRange.end.character);
    if (include) return { kind: 'include', include };
  }
  const ma = memberAccessAt(text, position);
  if (!ma) return { kind: 'none' };               // ma null ⟺ wordAt null
  if (ma.receiver) return { kind: 'member', receiver: ma.receiver, member: ma.member };
  return { kind: 'symbol', word: ma.member };
}
```
`cursorTargetAt` and `CursorTarget` are re-exported from the `index/index.ts` barrel; handlers import them from `'../index'`. Dependency check: `index/cursorTarget.ts` → `parser/include/lineScanner` (leaf) + `index/wordAt` (re-export of `parser/lexical/cursor`); no cycle.

---

# Tasks

### Task C1 — Add `CursorTarget` + `cursorTargetAt` + unit tests

**Files:** create `server/src/index/cursorTarget.ts`; edit `server/src/index/index.ts` (barrel re-export of `cursorTargetAt` + type `CursorTarget`); create `server/tests/index/cursorTarget.test.ts`.

**Steps:** implement the classifier exactly as above. Barrel: `export { cursorTargetAt } from './cursorTarget'; export type { CursorTarget, CursorTargetOptions } from './cursorTarget';`. Table-driven tests:
- include path → `{ kind:'include', include.path:'X.hlsl' }`; cursor on the `#include` keyword (not the path) → `symbol`/`none`; include line with `detectIncludes:false` → `symbol` (path token), NOT include; `#include` inside a `/* */` comment → not detected (scanIncludes strips comments) → falls through.
- `lights[i].color` cursor on `color` → `member` with `receiver.text:'lights[i]'`, `member.text:'color'`.
- plain identifier → `symbol`; whitespace/empty position → `none`.

**Verify:** `npm run build` clean; `npm run test -w server` → **>607** pass (new cases), 1 skip. New file passes.
**Commit:** `feat(issue-30): add CursorTarget union and cursorTargetAt classifier`.

### Task C2 — Migrate `definition.ts`

Replace the inline include find (59–63) and the direct `memberAccessAt`(167)/`wordAt`(193) calls with one `const target = cursorTargetAt(fullText, params.position);` computed up front. Preserve **exact ordering**:
1. `case 'include'` → the existing resolve-include + LocationLink jump (use `target.include.path` / `target.include.pathRange`). Must run **before** idx load (so an include-click still works when idx is null) — i.e. branch on `target.kind === 'include'` before the `workspace.store.get` block.
2. load idx (+ reindex fallback); `if (!idx) return null`.
3. `propertyAt(idx, position)` forward bridge — **unchanged**, still before the gate.
4. `if (!isGenericDefinitionContext(...)) return null;` — unchanged.
5. **Preserve definition's SEQUENTIAL structure — do NOT model member as a terminal `switch` arm.** Today (`definition.ts:172-239`) a member access tries `resolveMember`, returns *only if* `links.length > 0`, and on a member-resolution **miss falls through** to unconditional `resolveDefinition(word.text)` **plus** reverse `findPropertyCandidatesForName(word.text)`, where `word.text === member.text`. So `foo.PropName` that misses member resolution but matches a global symbol or a ShaderLab property still resolves. Implement as:
   - `if (target.kind === 'none') return null;` (after the gate).
   - `if (target.kind === 'member') { const links = resolveMember(target.receiver.text, target.member.text, …); if (links.length > 0) return links.map(… originSelectionRange: target.member.range); }` — then **fall through** (no early return on miss).
   - Then, for BOTH member and symbol, `const word = target.kind === 'member' ? target.member : target.word;` and run the existing `resolveDefinition(word.text)` + reverse `findPropertyCandidatesForName(word.text, store)`, `originSelectionRange: word.range`. (`'include'` already handled at step 1.)
Keep all `trace(...)` calls equivalent.

**Add a regression guard** (this fallthrough is currently UNTESTED — verify by adding the test on the *unrefactored* code first, watch it pass, then refactor): in `tests/handlers/definition.test.ts` (or `definition-properties.test.ts`), a case where the cursor is on `x.PropName` such that `PropName` is **not** a struct member of `x`'s type but **is** a ShaderLab property (or a global symbol) — assert F12 still returns that symbol/property link via the member→symbol/property fallthrough.

**Verify:** `npm run build`; `npm run test -w server` (esp. `definition.test.ts`, `definition-include.test.ts`, `definition-properties.test.ts`, plus the new fallthrough case) all green, count = baseline + the new case(s). `grep -n "scanIncludes\|memberAccessAt\|wordAt" server/src/handlers/definition.ts` → none.
**Commit:** `refactor(issue-30): route definition through CursorTarget` (includes the fallthrough guard test).

### Task C3 — Migrate `references.ts`

Replace `scanIncludes`+`includePathContainsPosition` (delete the local helper) and the `wordAt`(94) call with `const target = cursorTargetAt(fullText, params.position);`.
- `case 'include'` → the existing "who-includes-this-header" walk (uses `target.include.path`), unchanged.
- `case 'none'` → `return null` (was the `if (!word) return null`).
- `case 'member' | 'symbol'` → `const word = target.kind === 'member' ? target.member : target.word;` then the existing reference resolution unchanged, using `word.text` for the `queryName` fallback. **Do not** add a gate (references is gateless today).

**Verify:** build; full suite green at baseline. The include-branch guard already exists — `references.test.ts:1152` exercises Find References with the cursor inside `#include "Common.hlsl"` (position `{line:0,character:12}`); it must stay green. `grep -n "scanIncludes\|includePathContainsPosition\|wordAt" server/src/handlers/references.ts` → none.
**Commit:** `refactor(issue-30): route references through CursorTarget`.

### Task C4 — Migrate `hover.ts`

Keep the current order: load idx → `isGenericDefinitionContext` gate → classify → resolve. Replace the `memberAccessAt`(50)/`wordAt`(51,88) probe with `const target = cursorTargetAt(fullText, params.position, { detectIncludes: false });` computed **before** `collectVisibleUriKeys` (preserve the "probe cheap token state before the visibility walk" optimization). Then:
- `target.kind === 'none'` → return null (was `if (!memberAccess?.receiver && !word) return null`).
- `case 'member'` → `resolveMemberSymbols(receiver.text, member.text)`; on empty result **fall through** to word resolution using `target.member` as the word (parity with today's fallthrough), then builtins.
- `case 'symbol'` → `resolveDefinitionSymbols(word.text)`, then builtins; `range: target.word.range`.
- (`'include'` cannot occur with `detectIncludes:false`; treat any non-member/symbol as null.)
Member hover uses `range: target.member.range`; symbol/fallback hover uses the resolved word's range.

**Verify:** build; `hover.test.ts` + full suite green at baseline. `grep -n "memberAccessAt\|wordAt\|scanIncludes" server/src/handlers/hover.ts` → none.
**Commit:** `refactor(issue-30): route hover through CursorTarget`.

### Task C5 — Migrate `documentHighlight.ts`

Keep order: load idx → gate → classify → resolve. Replace `wordAt`(148)/`memberAccessAt`(157) with `const target = cursorTargetAt(fullText, params.position, { detectIncludes: false });`. **Placement matters:** today `wordAt` (null-check) is at `:148`, *before* `collectVisibleUriKeys` (`:151`), while `memberAccessAt` is at `:157` *after* it. Put the single `cursorTargetAt` call + the `target.kind === 'none' → return null` at the `:148` spot so the early-exit still precedes the visibility walk; only reach `collectVisibleUriKeys` for member/symbol.
- `target.kind === 'none'` → return null (was `if (!word) return null`).
- `case 'member'` → `resolveMemberSymbols(...).map(symbolToTarget)`; preserve the `sameReceiverMemberLocations` fallback when targets are empty (uses `target.receiver`/`target.member`).
- `case 'symbol'` → `resolveReferenceTargets(index, fullText, position, ...)` (unchanged).
- `queryName` fallback: `targets[0]?.name ?? (target.kind==='member' ? target.member.text : target.word.text)`.
The shared scoped/member/global narrowing and the declarations+references collection below stay unchanged.

**Verify:** build; `documentHighlight.test.ts` + full suite green at baseline. `grep -n "memberAccessAt\|wordAt\|scanIncludes" server/src/handlers/documentHighlight.ts` → none.
**Commit:** `refactor(issue-30): route documentHighlight through CursorTarget`.

---

## Sequencing
C1 first (adds the shared classifier). C2–C5 are independent of each other (each only rewires one handler to consume C1) and can be done in any order; recommended C2→C3→C4→C5. One commit per task, all under issue #30.

## Acceptance-criteria mapping (#30)
- [ ] definition/references/hover/documentHighlight no longer call `scanIncludes`/`memberAccessAt` directly → C2–C5 grep checks (also drop `wordAt`).
- [ ] No handler duplicates the include-click decision → it lives once in `cursorTargetAt` (C1); only definition (C2) and references (C3) consume the `include` kind.
- [ ] Full vitest + integration tests pass → each task verifies at baseline; final code review runs the Electron suite.
- [ ] Manual smoke (see below) — include jump, member chain lookup, property bridge, Find-References-on-include all unregressed.

## Risks & rollback
- **references gate regression** (biggest): if a gate sneaks in, identifiers in comments stop resolving. Mitigation: C3 explicitly adds no gate; `references.test.ts` guards.
- **definition include-before-idx ordering**: if idx load moves before the include branch, include-click breaks when idx is null. Mitigation: C2 branches on `'include'` before the idx block; `definition-include.test.ts` guards.
- **property bridge**: untouched by design; `definition-properties.test.ts` guards both forward and reverse directions.
- **hover/highlight perf**: `detectIncludes:false` keeps `scanIncludes` off their hot path.
- Each task is one revertable commit; the classifier (C1) is additive and harmless until a handler consumes it.

## Manual smoke checklist (F5 the extension on a representative `.shader`)
- F12 on `#include "X.hlsl"` path → jumps to the file (C2).
- F12 on `surface.color` → resolves via chain lookup (C2 member).
- F12 on a ShaderLab `_MainTex` property → bridges to the HLSL declaration (C2 property bridge, untouched).
- Find References on an `#include` path → returns referencing files (C3 include).
- Hover on a member access, Document highlight on an identifier → unchanged (C4, C5).

## Deviations from the issue text (carry into the #30 thread)
1. Union has **no `property` kind** (definition-only, idx-dependent, not a duplicated decision) — property stays definition's `propertyAt` step. 
2. The type is named after the real `IncludeDirective` (issue said `IncludeReference`); `resolved?: ResolvedInclude` is **not** carried on the union (resolution is async + handler-specific; handlers call `resolveInclude` themselves).
3. Added `detectIncludes` option so gated, latency-sensitive handlers (hover/documentHighlight) don't pay `scanIncludes`.
4. The `isGenericDefinitionContext` gate is intentionally kept per-handler (references stays gateless) rather than folded into the classifier.

---

## Review record (2026-05-29)

Reviewed by an adversarial plan-review subagent against the actual code (baseline confirmed: 607 pass / 1 skip). **Verdict: APPROVE WITH CHANGES** — applied below.

**Independently confirmed:** gate heterogeneity (references is gateless); definition's include-before-idx and property-before-gate ordering; `detectIncludes:false` is behavior-neutral for hover/documentHighlight (include paths are lexically strings → gate already returns null); property is definition-only (no other handler needs it); `memberAccessAt`/`wordAt` equivalence (`ma === null ⟺ wordAt === null`, `ma.member` IS the `wordAt` result); references' `word` usage is only null-check + `queryName` fallback; no import cycle; `index/` is the right home for #32.

**Blocking fix applied (the important one):** C2 originally modeled definition's member arm as a terminal `switch` case, which would have **dropped definition's member→symbol/property fallthrough** — `foo.PropName` that misses member resolution but matches a global/property still resolves today (`definition.ts:172-239`), and **no existing test guards it**. C2 rewritten to preserve the sequential fall-through, and a regression guard test was added to C2 (added on the unrefactored code first to prove it passes, then kept through the refactor).

**Non-blocking fixes applied:** classifier sketch now imports `Position` from `@unity-shader-nav/shared`; C5 calls out the placement (classifier + `none`-return must sit at the pre-`collectVisibleUriKeys` spot); C3 cites the existing include-branch guard `references.test.ts:1152` (so no new test needed there).
