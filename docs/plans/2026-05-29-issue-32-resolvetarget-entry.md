# resolveTarget(CursorTarget, ctx) Single Resolver Entry (#32) Implementation Plan

> **For the executor:** Implement task-by-task; after each Task run its verification and make the specified commit (all under issue #32). Commands run from `unity-shader-nav/`. Behavior-preservation is the bar — the existing resolver unit tests and the definition/references handler tests are the oracle; never edit a test to make it pass.

**Goal:** Give the navigation handlers a single high-level resolution entry. `definition.ts` resolves via `resolveTarget(CursorTarget, ctx): SymbolEntry[]`; `references.ts` collects via `collectReferences(CursorTarget, ctx): Promise<Location[]>`. Neither handler imports any of the seven legacy `resolve*` functions afterward. Public-interface consolidation only — resolver internals are NOT refactored.

**Architecture:** Add `resolveTarget` + `ResolverContext` and `collectReferences` + `ReferenceCollectionContext` in `index/` (new `index/resolveTarget.ts`), thin dispatchers over the existing `resolveMemberSymbols`/`resolveDefinitionSymbols`/`resolveReferenceTargets*`. `resolveTarget` is **pure dispatch** (member→`resolveMemberSymbols`, symbol→`resolveDefinitionSymbols`); the handler-specific control flow (definition's member→symbol fall-through, reverse-property, the property bridge) stays in `definition.ts`. `collectReferences` extracts the references handler's symbol-reference collection body verbatim, taking the cursor's targets from a `CursorTarget` via a new `resolveReferenceTargetsForCursor`. The include "who-includes-this-header" branch stays in `references.ts` (it's include-specific, not one of the seven).

**Tech Stack:** TypeScript (ESM, `server/` workspace), Vitest unit + Electron integration tests.

---

**Plan-authoring commit guidance:** When writing/reviewing *this plan only*, commit just this file: `docs(issue-32): plan resolveTarget single resolver entry`.

---

## 0. Pre-flight: verified facts (re-confirm before editing)

Verified 2026-05-29 (after #26/#27/#30 landed).

### The seven legacy `resolve*` and their relationships
- `resolveDefinition(idx,name,pos,global,opts): LocationLink[]` === `resolveDefinitionSymbols(...).map(asLink)` (`symbolResolver.ts:115`). `asLink` = `{targetUri,targetRange,targetSelectionRange}` all from `symbol.location`.
- `resolveMember(...): LocationLink[]` === `resolveMemberSymbols(...).map(toLink)` (`chainLookup.ts:362`); `toLink` is byte-identical to `asLink`.
- So a `resolveTarget` returning `SymbolEntry[]` is behavior-equivalent for definition, which maps symbols→links itself (adding `originSelectionRange`).
- `resolveReferenceTargets(idx,text,pos,global,opts)` (`referenceResolver.ts:66`) internally does `memberAccessAt(text,pos)` + `wordAt(text,pos)`: member-receiver→`resolveMemberSymbols→toReferenceTarget`, returns if non-empty, else falls through to `resolveReferenceTargetsForName(word.text)`. **This is exactly the CursorTarget member/symbol decision** — so it is expressible from a pre-computed `CursorTarget`.
- `resolveReferenceTargetsForName` has an exact-declaration special case (param/local/structMember at the cursor) before delegating to `resolveDefinitionSymbols`. `toReferenceTarget` is **private** to `referenceResolver.ts`.

### Caller map (who imports each — determines what can leave the barrel)
| function | production callers | test callers (import path) |
|---|---|---|
| `resolveDefinition` | **definition.ts only** (barrel) | symbolResolver/integration/macros tests — all **deep** (`../../src/index/symbolResolver`) |
| `resolveMember` | **definition.ts only** (barrel) | chainLookup test — **deep** (`../../src/index/chainLookup`) |
| `resolveDefinitionSymbols` | hover.ts (barrel) + definition.ts property bridge | — |
| `resolveMemberSymbols` | hover.ts + documentHighlight.ts (barrel) | — |
| `resolveReferenceTargets` | documentHighlight.ts + references.ts (barrel) | referenceResolver test (**barrel**) |
| `resolveReferenceTargetsForName` | documentHighlight.ts + references.ts (barrel) | — |
| `resolveReferenceTargetsForMemberReference` | documentHighlight.ts + references.ts (barrel) | — |

**Consequence:** after definition migrates, `resolveDefinition` + `resolveMember` have **no barrel importers** (tests use deep module paths) → they can be removed from `index/index.ts` ("become internal to index/"). The other five stay in the barrel (hover/documentHighlight/tests still use them). `definition.test.ts` only mentions the names in a comment — it does not import them.

### Types / cycles
- No `ResolvedSymbol` type exists — use `SymbolEntry` (`@unity-shader-nav/shared`).
- `include/` does not import `index/` (no cycle) — but `collectReferences` won't need `resolveInclude` because the include branch stays in `references.ts`.
- Current baseline: **615 pass / 1 skip** (server vitest); 35/35 Electron.

---

## Design decisions (challenge these in review)

1. **`resolveTarget` returns `SymbolEntry[]`, not links.** Matches the issue's "ResolvedSymbol[]" (no such named type; `SymbolEntry` is it). definition maps symbols→`LocationLink` itself (equivalent to the old `resolveDefinition`/`resolveMember` `.map(asLink)`).
2. **`resolveTarget` is pure dispatch — no fall-through, no property.** definition keeps its member→symbol fall-through and its property bridge as its own control flow (calling `resolveTarget` with the appropriate target). This honors "internals not refactored" and avoids baking definition-specific semantics into the shared entry (documentHighlight's member fallback differs and isn't migrating).
3. **Only `resolveDefinition` + `resolveMember` leave the barrel.** The other five have remaining external callers (hover/documentHighlight/tests), so per the AC they stay. Net public barrel: −2 link variants, +2 entries (`resolveTarget`, `collectReferences`). The link variants remain module-exported (for deep-path unit tests).
4. **`collectReferences` extracts the references symbol-reference body; the include branch stays in `references.ts`.** The include "who-includes-this-header" walk uses `resolveInclude`/`uniqueLocations` (neither is one of the seven), so leaving it in references still satisfies "no longer import any of the seven legacy resolve*." references keeps importing `resolveInclude` + `uniqueLocations`.
5. **Add `resolveReferenceTargetsForCursor` rather than refactor `resolveReferenceTargets`.** A small new function in `referenceResolver.ts` expresses the member/symbol dispatch on a pre-computed `CursorTarget` (using the private `toReferenceTarget`). `resolveReferenceTargets` (the fullText version, still used by documentHighlight + its unit test) is left untouched — ~8 lines of accepted duplication to avoid touching tested internals.

### Signatures
```ts
// index/resolveTarget.ts
export interface ResolverContext {
  index: FileIndex;
  global: GlobalSymbolIndex | null;
  position: Position;
  options?: ResolutionOptions;            // { visibleUriKeys, trace }
}
export function resolveTarget(target: CursorTarget, ctx: ResolverContext): SymbolEntry[] {
  switch (target.kind) {
    case 'member': return resolveMemberSymbols(ctx.index, ctx.global, target.receiver.text, target.member.text, ctx.position, ctx.options);
    case 'symbol': return resolveDefinitionSymbols(ctx.index, target.word.text, ctx.position, ctx.global, ctx.options);
    default:       return [];             // include | none
  }
}

export interface ReferenceCollectionContext {
  index: FileIndex | undefined;
  position: Position;
  global: GlobalSymbolIndex;
  globalRefs: GlobalReferenceIndex;
  store: IndexStore;
  includeCtx: IncludeContext;
  isInPackages: (uri: string) => boolean;
  includePackages: boolean;
  includeDeclaration: boolean;
}
export async function collectReferences(target: CursorTarget, ctx: ReferenceCollectionContext): Promise<Location[]>;

// referenceResolver.ts (new export)
export function resolveReferenceTargetsForCursor(
  index: FileIndex, target: CursorTarget, position: Position,
  global?: GlobalSymbolIndex | null, options?: ResolutionOptions,
): ReferenceTarget[];   // member→resolveMemberSymbols.map(toReferenceTarget), fallthrough to ForName(member.text); symbol→ForName(word.text); else []
```

---

# Tasks

### Task D1 — Add `resolveTarget` + `ResolverContext` + unit tests
**Files:** create `server/src/index/resolveTarget.ts` (just `ResolverContext` + `resolveTarget` for now); edit `server/src/index/index.ts` (barrel-export both); create `server/tests/index/resolveTarget.test.ts`.

**Steps:** implement `resolveTarget` exactly as the sketch (dispatch over `resolveMemberSymbols`/`resolveDefinitionSymbols`, `include`/`none`→`[]`). Barrel: `export { resolveTarget } from './resolveTarget'; export type { ResolverContext } from './resolveTarget';`. Table-driven tests over a small in-memory `FileIndex`: symbol target → the global's `SymbolEntry`; member target on a struct field → the member `SymbolEntry`; member target where the receiver type is unknown → `[]`; member target where the receiver type resolves but the member name is absent → `[]` (documents that the dispatch does NOT fall through — that's definition's job, and distinguishes the two `[]` paths); `none`/`include` target → `[]`. Assert multi-candidate (two same-name globals) returns both (ADR-0001).

**Verify:** `npm run build`; `npm run test -w server` → >615 pass, 1 skip; new file green.
**Commit:** `feat(issue-32): add resolveTarget single definition-resolution entry`.

### Task D2 — Migrate `definition.ts` to `resolveTarget`; remove link variants from the barrel
**Files:** `server/src/handlers/definition.ts`; `server/src/index/index.ts`.

**Steps:** build `const ctx: ResolverContext = { index: idx, global: workspace.global, position: params.position, options: resolutionOptions }` (use the same `resolutionOptions` already in scope at each call site — note the property bridge has its own `propertyVisibleUriKeys`).
- **Property bridge** (currently `resolveDefinitionSymbols(idx, propertyHit.name, pos, global, {visibleUriKeys: propertyVisibleUriKeys, trace})`): replace with `resolveTarget({ kind: 'symbol', word: { text: propertyHit.name, range: propertyHit.nameRange } }, { index: idx, global: workspace.global, position: params.position, options: { visibleUriKeys: propertyVisibleUriKeys, trace } }).filter(s => s.kind === 'variable' || s.kind === 'cbuffer')`. Then map to LocationLinks with `originSelectionRange: propertyHit.nameRange` (unchanged).
- **Member arm**: `const memberSymbols = resolveTarget(target, ctx);` (target.kind==='member') → if `length>0`, map to links with `originSelectionRange: target.member.range`. On miss, **fall through** (no early return).
- **Symbol arm / member-miss fall-through**: `const word = target.kind==='member' ? target.member : target.word; const symbols = resolveTarget({ kind: 'symbol', word }, ctx);` → map to links with `originSelectionRange: word.range`; keep the reverse `findPropertyCandidatesForName(word.text, store)` block + the merge unchanged.
- Imports: drop `resolveDefinition`, `resolveMember`, `resolveDefinitionSymbols`; add `resolveTarget` and `type ResolverContext`. Keep `collectVisibleUriKeys`, `findPropertyCandidatesForName`, `propertyAt`, `cursorTargetAt`.
- **Barrel**: remove `resolveDefinition` and `resolveMember` from `index/index.ts` (now orphaned — tests import them from `./symbolResolver`/`./chainLookup` deep paths, which still work). Leave `resolveDefinitionSymbols`/`resolveMemberSymbols` in the barrel (hover/documentHighlight).

**Verify:** `npm run build`; `npm run test -w server` (esp. `definition.test.ts`, `definition-include.test.ts`, `definition-properties.test.ts`, plus the deep-path `symbolResolver.test.ts`/`chainLookup.test.ts` still resolve) all green at baseline. `grep -n "resolveDefinition\b\|resolveMember\b\|resolveDefinitionSymbols" server/src/handlers/definition.ts` → none. `grep -n "resolveDefinition\b\|resolveMember\b" server/src/index/index.ts` → none.
**Commit:** `refactor(issue-32): route definition through resolveTarget`.

### Task D3 — Add `collectReferences` + `resolveReferenceTargetsForCursor`; migrate `references.ts`
**Files:** `server/src/index/referenceResolver.ts` (add `resolveReferenceTargetsForCursor`); `server/src/index/resolveTarget.ts` (add `collectReferences` + `ReferenceCollectionContext`); `server/src/index/index.ts` (barrel-export `collectReferences` + the type); `server/src/handlers/references.ts`.

**Steps:**
1. In `referenceResolver.ts`, add `resolveReferenceTargetsForCursor` (sketch above) — member→`resolveMemberSymbols(...).map(toReferenceTarget)`, on empty fall through to `resolveReferenceTargetsForName(target.member.text, ...)`; symbol→`resolveReferenceTargetsForName(target.word.text, ...)`; else `[]`. (Uses the private `toReferenceTarget`. Do NOT modify `resolveReferenceTargets`.) Import `CursorTarget` from `./cursorTarget`.
2. In `resolveTarget.ts`, add `async function collectReferences(target, ctx): Promise<Location[]>` = the body of `references.ts` lines ~85–188 — but the move is **NOT purely verbatim**; three locals it reads are defined *outside* that range and must be re-derived at the top of the function (a careless verbatim copy will fail to compile — caught by the review):
   - **`idx`** (defined at references.ts:85 as `workspace.store?.get(uri)`): open with `const idx = ctx.index;` (the caller passes `index: workspace.store.get(uri)`).
   - **`word`** (defined at references.ts:83, used only at `queryName = targets[0]?.name ?? word.text`): re-derive `const word = target.kind === 'member' ? target.member : target.word;` (the target is guaranteed member|symbol — references handles include/none before calling).
   - **`params.textDocument.uri`** (read at references.ts:95 for the document's own visibility): replace with `ctx.index.uri` (`FileIndex.uri`), guarded so the `idx`-undefined path still yields `visibleUriKeys = undefined`/`targets = []` exactly as today (i.e. only compute `visibleForUri(ctx.index.uri)` when `idx` is truthy).
   - **`targets`**: `const targets = idx ? resolveReferenceTargetsForCursor(idx, target, ctx.position, ctx.global, resolutionOptions) : []` — replaces `resolveReferenceTargets(idx, fullText, position, ...)`.
   Keep the rest unchanged: the `visibleByUri` cache + `collectVisibleUriKeys(ctx.store, ctx.includeCtx, uri)`, the scoped/member/global narrowing, `queryName`, the `includeDeclaration` symbolsAsReferences branch, the `globalRefs.lookup` loop with candidate matching (`resolveReferenceTargetsForName`/`resolveReferenceTargetsForMemberReference`), the final `uniqueLocations([...symbolsAsReferences, ...references])`. Use `ctx.isInPackages`, `ctx.includePackages`, `ctx.includeDeclaration`, `ctx.global`, `ctx.globalRefs`, `ctx.store`. Import the referenceMatching helpers (`isScopedTarget`, `isMemberTarget`, `isGlobalKindAwareTarget`, `narrowGlobalTargetsForOccurrence`, `isReferenceContextCompatible`, `sameTarget`, `symbolToTarget`, `uniqueLocations`) from `./referenceMatching`, the resolvers from `./referenceResolver`, `collectVisibleUriKeys` from `./visibility`, and `type ResolutionOptions` from `./symbolResolver` for the inner `resolutionOptions`.
3. Barrel: `export { collectReferences } from './resolveTarget'; export type { ReferenceCollectionContext } from './resolveTarget';`.
4. Migrate `references.ts`: keep the `cursorTargetAt` call + the `target.kind === 'include'` who-includes-me branch (unchanged; keeps `resolveInclude` + `uniqueLocations` imports) + `target.kind === 'none' → null`. For member/symbol: `return collectReferences(target, { index: workspace.store.get(uri), position: params.position, global: workspace.global, globalRefs: workspace.globalRefs, store: workspace.store, includeCtx: workspace.includeCtx, isInPackages: (u) => workspace.isInPackages(u), includePackages: workspace.settings.findReferences.includePackages, includeDeclaration: params.context.includeDeclaration });`. Drop the imports of `resolveReferenceTargets`, `resolveReferenceTargetsForName`, `resolveReferenceTargetsForMemberReference`, `isScopedTarget`, `isMemberTarget`, `isGlobalKindAwareTarget`, `narrowGlobalTargetsForOccurrence`, `isReferenceContextCompatible`, `sameTarget`, `symbolToTarget`, `collectVisibleUriKeys`; add `collectReferences`. Keep `uniqueLocations` (include branch) + `resolveInclude`.

**Verify:** `npm run build`; `npm run test -w server` → baseline green, **`references.test.ts` (19 tests)** is the regression oracle (incl. include-branch guard `:1152`, packages filter, includeDeclaration). `grep -nE "resolveReferenceTargets(\b|ForName|ForMemberReference)" server/src/handlers/references.ts` → none.
**Commit:** `refactor(issue-32): collect references through collectReferences entry`.

---

## Sequencing
D1 (resolveTarget + tests) → D2 (definition + barrel removal) → D3 (collectReferences + references). D2 and D3 are independent given D1.

## Acceptance-criteria mapping (#32)
- [ ] definition.ts + references.ts call `resolveTarget`/`collectReferences`; no longer import any of the seven legacy `resolve*` → D2/D3 grep checks.
- [ ] Legacy `resolve*` exports become internal or deleted where no callers remain → `resolveDefinition`+`resolveMember` removed from the barrel (D2); the other five retained (hover/documentHighlight/tests still consume them) — documented.
- [ ] ADR-0001 multi-candidate unchanged → `resolveTarget`/dispatch return all candidates; D1 test asserts it; existing `#ifdef`/multi-Pass tests stay green.
- [ ] Chain lookup unchanged → `resolveMemberSymbols` untouched; `chainLookup.test.ts` + `surface.color` cases green.
- [ ] Full vitest passes → each task verifies at baseline; code review runs the Electron suite.

## Risks & rollback
- **`collectReferences` extraction fidelity** (biggest): it's a ~100-line verbatim move. Mitigation: move logic unchanged; `references.test.ts` (19 tests incl. packages filter, includeDeclaration, scoped/member narrowing) is the oracle. Diff the moved body against the original line-by-line.
- **Property-bridge synthetic target**: must pass `propertyVisibleUriKeys` + `trace` (not the main `resolutionOptions`) and keep the `variable|cbuffer` filter. `definition-properties.test.ts` guards.
- **Barrel removal** of `resolveDefinition`/`resolveMember`: confirm no remaining barrel importer (definition migrated; tests use deep paths). Build + tests catch a miss.
- **`resolveReferenceTargetsForCursor` divergence** from `resolveReferenceTargets`: keep the member→fallthrough-to-name logic identical; `referenceResolver.test.ts` still guards the untouched `resolveReferenceTargets`.
- Each task is one revertable commit; D1 is additive (harmless until consumed).

## Manual smoke (after all tasks; F5 on a representative `.shader`)
- F12 on a symbol / `surface.color` member / ShaderLab `_MainTex` property → resolve as before.
- Find References on an identifier (with/without declaration), on an `#include` path, with packages filter → unchanged.
- Hover + Document Highlight (NOT migrated) → unchanged.

## Deviations from the issue text (carry into the #32 thread)
1. "ResolvedSymbol[]" → `SymbolEntry[]` (no such named type exists).
2. Only `resolveDefinition` + `resolveMember` leave the public barrel; the other five legacy functions are retained because hover/documentHighlight (out of scope for #32) and unit tests still call them — so the "single entry" is realized for definition/references, not by deleting all seven.
3. `resolveTarget` is pure dispatch; definition's member→symbol fall-through, reverse-property, and the property bridge stay in `definition.ts`.
4. The include "who-includes-this-header" branch stays in `references.ts` (not folded into `collectReferences`); it uses `resolveInclude`/`uniqueLocations`, neither of which is one of the seven. Note: `uniqueLocations` ends up imported in *both* `references.ts` (include branch) and `resolveTarget.ts` (collectReferences) — that's fine; don't "move" it out of references.

---

## Review record (2026-05-29)

Reviewed by an adversarial plan-review subagent against the source (baseline confirmed 615 pass / 1 skip, build green). **Verdict: APPROVE WITH CHANGES** — applied.

**Verified at byte level:** `asLink`≡`toLink` and `resolveDefinition`/`resolveMember` are exactly their `*Symbols` variants `.map(...)` (same order/dedup) → handler-side mapping is equivalent; barrel removal of `resolveDefinition`/`resolveMember` is safe (production importer = definition only; tests use deep module paths; `definition.test.ts` only mentions them in a comment); property-bridge synthetic target ≡ today's `resolveDefinitionSymbols(propertyHit.name, …)` with the `variable|cbuffer` filter; member fall-through preserved via a second `resolveTarget({kind:'symbol', word})`; `resolveReferenceTargetsForCursor` matches `resolveReferenceTargets`'s member/symbol dispatch because `memberAccessAt(...).member` IS `wordAt(...)` (cursor.ts:85); all `ReferenceCollectionContext` fields exist on `workspace`; no import cycle (`cursorTarget` does not import `referenceResolver`); ADR-0001/chain lookup preserved; task sequencing has no broken intermediate.

**Blocking fixes applied (both in D3 step 2):** the `collectReferences` move is NOT purely verbatim — `idx` (`= ctx.index`), `word` (re-derived from `target`), and `params.textDocument.uri` (`→ ctx.index.uri`, idx-guarded) are locals defined outside the moved range and are now spelled out explicitly, so the extraction compiles.

**Non-blocking applied:** D1 test now also covers "receiver type resolves but member absent → []" (distinct from "no receiver type → []"); noted `uniqueLocations` legitimately has two importers; confirmed the inner options type is `ResolutionOptions` from `./symbolResolver`.
