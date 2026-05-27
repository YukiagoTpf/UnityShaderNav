# Dim Inactive And Variant-Dependent Preprocessor Branches Implementation Plan

> **For Claude:** Implement this plan task-by-task. Execute one Task, then commit
> one `feat(issue-22)` / `test(issue-22)` commit before starting the next, per
> `CLAUDE.md` 执行纪律. The plan-authoring commit (`docs(issue-22)`) is separate
> and described at the end.

**Goal:** Add a first-pass editor aid that visually dims inactive and
variant-dependent `#if`/`#ifdef`/`#ifndef` preprocessor branches in Unity shader
(`.shader`) and HLSL (`.hlsl`/`.cginc`/`.hlslinc`/`.compute`) files, so authors
can read Rider-style which branches are off or variant-gated — without claiming
compiler-accurate Unity variant evaluation.

**Architecture:** A new pure server analyzer (`server/src/parser/preproc`) classifies each
preprocessor branch as visible or dimmed from file-local `#define`/`#undef`
state plus Unity variant keywords declared by `#pragma multi_compile` /
`shader_feature` family pragmas. A pull-model custom LSP request
(`unityShaderNav/inactiveRegions`) mirrors the existing semantic-tokens handler:
the client requests dimmed ranges for a document, the server runs the analyzer
on the document text, and the client renders the ranges with a
reduced-opacity `TextEditorDecorationType`. This affects presentation only — it
never touches definition, references, completion, or signature-help results.

**Tech Stack:** TypeScript, npm workspaces (`shared` / `server` / `client`),
`vscode-languageserver` (server), `vscode-languageclient` (client), Vitest
(server unit tests; server has no `vitest.config.*` — it uses Vitest defaults that
pick up `tests/**/*.test.ts`), Mocha + `@vscode/test-electron`
(client/integration), existing `server/src/parser/shaderlab/blockScanner.ts`
block scanner and `server/src/parser/preproc/scanDefines.ts`.

---

## Context

Current behavior:

- `server/src/parser/shaderlab/blockScanner.ts` `scanBlocks(text): ScanResult`
  returns `{ blocks: ShaderLabBlock[] }` for the HLSL/CG blocks inside a
  `.shader` file. Each `ShaderLabBlock` (type in `shared/src/structure.ts`)
  exposes `contentStartLine`/`contentEndLine`, both **0-based and inclusive**:
  `contentStartLine` is the first content line (`startLine+1`) and
  `contentEndLine` is the **last** content line (`endLine-1`), so the block body
  is `lines[contentStartLine] .. lines[contentEndLine]` inclusive. Existing
  callers use `lines.slice(contentStartLine, contentEndLine + 1)` and
  `contentStartLine <= line <= contentEndLine` — match that convention (the
  slice end is `contentEndLine + 1`). The scanner is comment-aware. Standalone
  `.hlsl`/`.cginc`/`.compute` files are all-HLSL.
- `server/src/parser/preproc/scanDefines.ts` already scans `#define NAME` line
  by line and is comment-aware via a local `stripComments(lineText,
  inBlockComment)` helper (handles `//` and `/* */`, including multi-line block
  comments). It does **not** handle `#undef`, `#pragma`, or `#if` branches. Note:
  `stripComments` is currently a non-exported, file-local function in
  `scanDefines.ts` — extracting it is a refactor, not a simple import.
- `server/src/handlers/semanticTokens.ts` is the closest existing feature: a
  pull-model handler registered via `registerSemanticTokensHandler(connection,
  documents, manager, suspender)`. It registers through
  `connection.languages.semanticTokens.on(...)` (a typed LSP capability), not a
  custom `connection.onRequest`. It resolves the workspace/index, reads the
  document text via `documents.get(uri)?.getText()`, and returns data. It uses
  `manager.workspaceForOrCreateFile`, `workspace.store.get(uri)`, and
  `workspace.reindex(...)` when no index is cached, and wraps the work in
  `suspender.run(...)` (signature `run<T>(work: () => Promise<T>): Promise<T |
  null>`, so callers fall back to a default on `null`).
- Semantic tokens colorize individual tokens via a fixed legend; they cannot
  dim whole regions (comments, blank lines, nested directives). Region dimming
  is therefore done with client decorations, not the semantic-tokens legend.
- The client (`client/src/client.ts`) creates the `LanguageClient`, forwards
  config changes for the sections listed in `SETTINGS_SECTIONS`, and the
  extension entry (`client/src/extension.ts`) already subscribes to one custom
  notification (`unityShaderNav/mode`). There is currently **no** decoration
  code on the client.
- Settings live in `shared/src/settings.ts` (`ExtensionSettings` +
  `DEFAULT_SETTINGS`), are merged server-side in `server/src/config/settings.ts`
  (`mergeSettings`, where nested groups `findReferences` and `debug` are spread
  over their defaults), resolved per-scope via `loadSettings(connection,
  scopeUri)` (re-exported from `server/src/config`), and are declared for VS
  Code in `client/package.json` `contributes.configuration.properties`.
  `shared` has no `index.ts`; the package entry is `shared/src/protocol.ts`
  (`main`/`types` point at `out/protocol.js`), which `export *`s `cache`,
  `settings`, `structure`, and `symbols`. `Range` and `Position` are exported
  from `shared/src/symbols.ts` (re-exported through `protocol.ts`).
- Server settings flow to the analyzer through `WorkspaceManager` settings; the
  analyzer itself is pure and does not read settings — the request handler and
  client gate on the enable flag.

What this plan adds: a `#undef`-aware, `#pragma`-aware preprocessor branch
analyzer; a custom LSP request to deliver dimmed ranges; client decoration
rendering and triggering; two new settings; tests; and docs/ADR.

### Design decisions (rationale; reviewers may sharpen)

1. **Pull request, not server push.** The semantic-tokens handler is already a
   pull handler and proves the pattern (resolve index, read document text,
   return result). A custom request `unityShaderNav/inactiveRegions` reuses
   `RequestSuspender` and avoids wiring a push into the `reindex` pipeline.
   Server push (like `unityShaderNav/mode`) was considered and rejected for the
   first pass to keep the change localized. **Caveat:** unlike the built-in
   semantic-tokens request, a custom `onRequest` gets **no** automatic document
   version / refresh handling, so the protocol carries `textDocument.version`
   and the client guards against stale responses (see Task 4 Step 2 and Task 5
   Step 1).
2. **Client decorations, not semantic-token modifiers.** Only decorations can
   dim a whole region (including comments/blank lines/nested directives) at a
   configurable opacity. This is also how Rider/C++ "inactive region" dimming
   works.
3. **First pass merges "definitely inactive" and "variant-dependent" into one
   dimmed presentation**, as the issue allows. The analyzer still tracks the
   distinction internally (`reason: 'inactive' | 'variant'`) so a later issue
   can split the presentation without re-deriving it.
4. **Conservatism = bias against false dimming.** A guard macro that has never
   appeared in the local flow and is not a known Unity variant keyword is
   treated as `UNKNOWN` and left **visible** (it may be defined in an unscanned
   include). We only dim branches we can justify: definitely-false branches
   (incl. a name explicitly `#undef`'d locally) and variant-gated branches. This
   honors the "handled conservatively" acceptance criterion and the cross-file
   non-goal. In the four-valued logic, `UNKNOWN` therefore **dominates**
   `VARIANT` (a branch that *might* be active via an unknown macro must not be
   dimmed as variant-only).
5. **`.shader` preprocessing-unit model.** Unity textually prepends
   `HLSLINCLUDE`/`CGINCLUDE` block bodies to every program block in scope, and
   ADR-0001 records that include-block symbols are visible to all subsequent
   passes. So the analyzer does **not** treat each block in total isolation:
   (a) Unity variant keywords are collected **file-wide** across all HLSL/CG
   blocks, and (b) each `HLSLPROGRAM`/`CGPROGRAM` block's `#define`/`#undef`
   flow is **seeded** by the definite macro state accumulated from the
   `HLSLINCLUDE`/`CGINCLUDE` blocks that precede it in document order. A program
   block's own defines stay local to that block (they do not leak into sibling
   program blocks / other passes). Precise multi-`SubShader` scoping and defines
   that are themselves inside include-block conditionals are approximated, not
   modeled exactly — documented in ADR-0005.

---

### Task 1: Scan Unity Variant Keywords From Pragmas

**Files:**
- Create: `unity-shader-nav/server/src/parser/preproc/scanVariantKeywords.ts`
- Create: `unity-shader-nav/server/tests/parser/preproc/scanVariantKeywords.test.ts`

**Step 1: Implement `scanVariantKeywords(text): Set<string>`**

Reuse the comment-stripping approach already in `scanDefines.ts` (copy the
`stripComments` helper or extract a shared `stripLineComments` util in
`parser/preproc/stripComments.ts` — extraction preferred to avoid duplication;
if extracted, update `scanDefines.ts` to import it in the same task).

Recognize variant-declaring pragmas with a prefix match so the whole family is
covered conservatively:

- `#pragma multi_compile ...`
- `#pragma multi_compile_local ...`
- `#pragma multi_compile_fragment ...` (and other `multi_compile*` suffixes)
- `#pragma shader_feature ...`
- `#pragma shader_feature_local ...`
- `#pragma shader_feature_fragment ...` (and other `shader_feature*` suffixes)

Match rule: a line whose stripped, trimmed content matches
`^#\s*pragma\s+(multi_compile\w*|shader_feature\w*)\s+(.*)$`. Each
whitespace-separated token in the remainder is a variant keyword **except** the
bare single underscore `_` (Unity's "feature off" placeholder — not a real
macro). Keep keywords that merely *start* with `_` (e.g. `_FOO`); only the
exact token `_` is dropped.

Return a `Set<string>` of all keyword names found anywhere in the file (pragmas
are declarations, so collect flow-insensitively).

**Step 2: Tests**

Cover, with inline strings (preferred) and/or a fixture:

- `multi_compile _ FOO_ON` → `{ FOO_ON }` (drops `_`).
- `multi_compile_local A B` and `shader_feature C` → `{ A, B, C }`.
- `shader_feature_local _ _VARIANT_ON` → `{ _VARIANT_ON }`.
- Suffixed families: `multi_compile_fragment X` and `shader_feature_fragment Y`
  are recognized.
- Commented-out pragmas (`// #pragma multi_compile _ FOO`) and pragmas inside
  `/* */` blocks contribute nothing.
- A non-variant pragma (`#pragma vertex vert`) contributes nothing.

**Step 3: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run tests/parser/preproc/scanVariantKeywords.test.ts
```

Expected: new suite passes; if `stripComments` was extracted, the existing
`scanDefines` suite still passes (`npx vitest run tests/parser/preproc`).

---

### Task 2: Evaluate Supported Preprocessor Conditions

**Files:**
- Create: `unity-shader-nav/server/src/parser/preproc/evalCondition.ts`
- Create: `unity-shader-nav/server/tests/parser/preproc/evalCondition.test.ts`

**Step 1: Define the four-valued result and evaluator**

```ts
export type CondValue = 'TRUE' | 'FALSE' | 'VARIANT' | 'UNKNOWN';

export interface MacroState {
  defined: ReadonlySet<string>;   // locally #define'd and still in effect
  undefed: ReadonlySet<string>;   // locally #undef'd and not since re-defined
  variants: ReadonlySet<string>;  // Unity variant keywords from pragmas
}
```

`evalDefined(name, state): CondValue` (order matters — explicit local state
beats variant inference, which beats absence):
- `state.defined.has(name)` → `TRUE`
- else `state.undefed.has(name)` → `FALSE`
- else `state.variants.has(name)` → `VARIANT`
- else → `UNKNOWN` (absence alone is never `FALSE` — could come from an include)

This is the corrected `#undef` semantics (review P1): a local `#undef X` is
authoritative for the rest of the local flow (it removes whatever an include may
have defined), so a later `#ifdef X` is **definitely inactive** (`FALSE` → dim)
and a later `#ifndef X` stays **visible** (`TRUE`), until X is re-`#define`'d. A
name that has *never* appeared locally (neither defined nor undef'd) and is not
a variant keyword stays `UNKNOWN` → visible. `#define X` adds X to `defined` and
clears it from `undefed`; `#undef X` adds X to `undefed` and clears it from
`defined` (both only while in definite scope — see Task 3). `FALSE` therefore
arises from a local `#undef`, or from negating a `TRUE` atom (e.g. `#ifndef X`
after `#define X`).

`evalCondition(kind, exprText, state): CondValue` supports the issue's subset:

- `#ifdef X` → `evalDefined(X)`
- `#ifndef X` → `not(evalDefined(X))`
- `#if defined(X)` / `#if defined X` → `evalDefined(X)`
- `#if !defined(X)` / `#if ! defined(X)` → `not(evalDefined(X))`
- `#if defined(A) && defined(B)` → `and(...)`
- `#if defined(A) || defined(B)` → `or(...)`
- `#elif <expr>` → same expression grammar as `#if`
- anything else (arithmetic, `#if 1`, macros with args, unsupported operators)
  → `UNKNOWN`

Four-valued logic helpers (kept conservative). **`UNKNOWN` dominates `VARIANT`**
after the absorbing definite value is checked — this is the review-P1 fix that
prevents false dimming: e.g. `defined(VARIANT_KW) || defined(UNKNOWN_FROM_INCLUDE)`
must be `UNKNOWN` (keep visible), because the unknown operand may be true at
compile time and then the branch does not depend on the variant. The same
pattern bites `and` (`VARIANT && UNKNOWN` → `UNKNOWN`), so both tables put
`UNKNOWN` ahead of `VARIANT`:

```
not:   TRUE→FALSE, FALSE→TRUE, VARIANT→VARIANT, UNKNOWN→UNKNOWN

and:   FALSE   if any operand FALSE        // absorbing for AND
       else UNKNOWN if any operand UNKNOWN  // can't decide ⇒ keep visible
       else VARIANT if any operand VARIANT  // all non-variant operands are TRUE
       else TRUE                            // all TRUE

or:    TRUE    if any operand TRUE         // absorbing for OR
       else UNKNOWN if any operand UNKNOWN  // can't decide ⇒ keep visible
       else VARIANT if any operand VARIANT  // all non-variant operands are FALSE
       else FALSE                           // all FALSE
```

So `VARIANT` is only produced when every operand that is *not* `VARIANT` is the
non-absorbing definite value (`TRUE` for `and`, `FALSE` for `or`) — i.e. the
branch genuinely toggles with the variant alone.

Keep the expression parser deliberately small: tokenize on `defined`, `(`, `)`,
`!`, `&&`, `||`, and identifiers. If parsing hits any token outside this set, or
mixes `&&` with `||` in a way the small parser does not model, return `UNKNOWN`.
Do not implement a general C expression evaluator.

**Step 2: Tests**

Table-driven over `CondValue` outcomes:

- A name in each of the four `MacroState` buckets — `defined` (`TRUE`),
  `undefed` (`FALSE`), `variants` (`VARIANT`), absent (`UNKNOWN`) — across
  `ifdef`/`ifndef`/`if defined`/`if !defined` (verify `ifndef` of an `undefed`
  name is `TRUE`, and `ifdef` of an `undefed` name is `FALSE`).
- `defined(A) && defined(B)` over all operand combinations → matches the `and`
  table; **explicitly** assert `VARIANT && UNKNOWN → UNKNOWN` and
  `VARIANT && TRUE → VARIANT`.
- `defined(A) || defined(B)` likewise → matches the `or` table; **explicitly**
  assert `VARIANT || UNKNOWN → UNKNOWN` and `VARIANT || FALSE → VARIANT`.
- Unsupported expressions (`#if A > 2`, `#if FOO(1)`, `#if 1`) → `UNKNOWN`.

**Step 3: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run tests/parser/preproc/evalCondition.test.ts
```

---

### Task 3: Analyze Inactive Regions (Core)

**Files:**
- Create: `unity-shader-nav/server/src/parser/preproc/analyzeInactiveRegions.ts`
- Create: `unity-shader-nav/server/tests/parser/preproc/analyzeInactiveRegions.test.ts`
- Create fixtures under `unity-shader-nav/server/tests/parser/preproc/fixtures/`
  as needed (inline strings preferred for readability).

**Step 1: Public API**

```ts
import type { Range } from '@unity-shader-nav/shared';

export interface DimmedRegion {
  range: Range;                 // whole-line range covering the dimmed body
  reason: 'inactive' | 'variant';
}

export interface AnalyzeOptions {
  /** true for .shader (analyze only inside HLSL/CG blocks); false = whole file. */
  isShaderLab: boolean;
}

export function analyzeInactiveRegions(text: string, options: AnalyzeOptions): DimmedRegion[];
```

**HLSL files** (`.hlsl`/`.cginc`/`.compute`): analyze the whole text as one
region; `scanVariantKeywords(text)` over the whole file.

**`.shader` files** (review-P1 preprocessing-unit model — do *not* analyze each
block in total isolation):

1. Run `scanBlocks(text)`; iterate the returned blocks in document order. Each
   block's content lines are `contentStartLine .. contentEndLine` **inclusive**
   (0-based); when slicing use `lines.slice(contentStartLine, contentEndLine + 1)`
   and add `contentStartLine` back to every emitted line number so ranges are in
   file coordinates.
2. **Variant keywords are file-wide:** run `scanVariantKeywords` over the union
   of all HLSL/CG block bodies (or over the whole file text) and pass that one
   `variants` set into every block's analysis. This captures the common case
   where `HLSLINCLUDE` declares `#pragma multi_compile _ FOO_ON` and a later
   `HLSLPROGRAM` uses `#ifdef FOO_ON`. (Collecting variants file-wide only ever
   makes more branches dim *as variant* and never causes a false dim, because
   `evalDefined` checks `defined`/`undefed` before `variants`.)
3. **Definite define state seeds program blocks from preceding include blocks:**
   maintain a running "shared base" (`baseDefined`/`baseUndefed`). When the
   iterated block is `HLSLINCLUDE`/`CGINCLUDE`, fold its **top-level definite**
   `#define`/`#undef` into the shared base after analyzing it. When the block is
   `HLSLPROGRAM`/`CGPROGRAM`, **seed** its analysis `defined`/`undefed` from the
   shared base but keep the block's own defines local (they do not mutate the
   shared base, so one pass's defines never leak into another pass). This
   handles `HLSLINCLUDE` `#define BAR_ON` → later `HLSLPROGRAM` `#ifndef BAR_ON`
   dimming. Multi-`SubShader` scoping and include-block defines nested inside
   conditionals are approximated, not exact (documented in ADR-0005).

**Step 2: Branch walk algorithm**

Walk lines top-to-bottom (comment-aware, reuse the shared strip helper).
Maintain:

- `defined: Set<string>` and `undefed: Set<string>` — definite macro state,
  **seeded** from the shared base (Step 1: empty for HLSL files / the first
  block; the include-accumulated base for later `.shader` program blocks). They
  are mutually exclusive: `#define X` adds to `defined` + removes from `undefed`;
  `#undef X` adds to `undefed` + removes from `defined`.
- `variants: Set<string>` — the file-wide set from Task 1 (Step 1.2).
- A stack of branch frames. Each frame records, for the currently-open clause:
  `dimmed: boolean`; `clauseDefinite: boolean` (this open clause is *definitely*
  active — i.e. it was entered with `CondValue == TRUE` from a `NONE_TAKEN`
  chain, or it is an `#else`/`#elif` whose chain proves it definite); chain
  bookkeeping `state ∈ { NONE_TAKEN, DEFINITELY_TAKEN, VARIANT_PENDING,
  UNKNOWN_PENDING }`; and the body start line.
- `definiteScope: boolean` — derived as "the stack is empty (top level) OR every
  open frame has `clauseDefinite === true`." Only `#define`/`#undef` directives
  encountered while `definiteScope` is true mutate `defined`/`undefed`. Crucially,
  **VISIBLE is not the same as definite**: a clause kept visible because its
  `CondValue` was `UNKNOWN` (the `UNKNOWN_PENDING` path, or an `#else`/`#elif`
  after an unknown) is `clauseDefinite = false`, so `#define`s inside it do NOT
  seed `defined` (they might not actually be compiled). Only `TRUE`-derived
  clauses and the top level are definite. Recompute `definiteScope` from the
  stack (or maintain a running count of non-definite open frames) on every push/
  pop so it correctly *restores* when a non-definite clause closes.

Per-clause presentation, computed when a clause opens (`#if`/`#ifdef`/`#ifndef`/
`#elif`/`#else`):

1. If any **enclosing** (ancestor) frame is dimmed → this clause is dimmed too.
   In practice this case rarely fires for *nested* directives, because Step 3's
   "do not descend into a dimmed clause's body" rule means the walker never
   reaches directives nested inside a dimmed clause — that whole body is emitted
   as one dimmed region. This rule is the safety net for the entry into a
   visible-parent's nested `#if`, and it never lets a clause be more-visible
   than its dimmed ancestor. Emit and skip detailed evaluation when it fires.
2. Otherwise compute the clause `CondValue` (`#else`/`#elif` derived from chain
   `state`, see below) and update `state`:

```
on #if / #ifdef / #ifndef:  push new frame; state = NONE_TAKEN; apply clause rule.
on #elif / #else:           reuse the current top frame; close the previous
                            clause's body range; apply the clause rule with the
                            frame's accumulated state.
clause rule given CondValue V and current frame.state:
  if state == DEFINITELY_TAKEN: presentation = DIM(inactive); clauseDefinite = false   // earlier clause definitely active
  elif state == VARIANT_PENDING: presentation = DIM(variant); clauseDefinite = false   // gated behind unresolved variant clause
  elif state == UNKNOWN_PENDING:
        V == FALSE → DIM(inactive), clauseDefinite = false
        else       → VISIBLE,       clauseDefinite = false                              // visible but NOT definite (conservative)
  else (NONE_TAKEN):
        V == TRUE    → VISIBLE; clauseDefinite = true;  state = DEFINITELY_TAKEN
        V == FALSE   → DIM(inactive); clauseDefinite = false   // state unchanged (NONE_TAKEN)
        V == VARIANT → DIM(variant); clauseDefinite = false;   state = VARIANT_PENDING
        V == UNKNOWN → VISIBLE; clauseDefinite = false;        state = UNKNOWN_PENDING
```

`#else` value derivation (no expression):

```
state == DEFINITELY_TAKEN → DIM(inactive); clauseDefinite = false
state == VARIANT_PENDING  → DIM(variant);  clauseDefinite = false
state == UNKNOWN_PENDING  → VISIBLE;        clauseDefinite = false   // a prior clause might have been true ⇒ not definite
state == NONE_TAKEN       → VISIBLE;        clauseDefinite = true     // all prior clauses FALSE ⇒ else definitely active
```

`#endif` pops the frame.

A clause's `reason` is `variant` when its dim originates from a `VARIANT`
condition or `VARIANT_PENDING` chain; otherwise `inactive`.

**Step 3: Range emission and nesting**

- When a clause is **dimmed**, emit one `DimmedRegion` covering the body lines of
  that clause — from the line **after** the opening directive through the line
  **before** the next clause directive (`#elif`/`#else`) or the closing
  `#endif`. "Do not descend" means do not *classify* the nested directives, but
  the walker **must still lexically track `#if`/`#endif` nesting depth while
  skipping the dimmed body** so it stops at the *matching-depth* sibling
  `#elif`/`#else`/`#endif` and not at a nested one. Concretely: increment a depth
  counter on every nested `#if`/`#ifdef`/`#ifndef` inside the skipped body and
  decrement on every `#endif`; a `#elif`/`#else`/`#endif` only closes the dimmed
  clause when the counter is back at the clause's own depth. Without this, a
  dimmed parent containing a nested `#if … #else … #endif` would wrongly treat
  the nested `#else`/`#endif` as the parent's boundary. The whole body (nested
  directives, comments, blank lines) is dimmed as one range; directive lines
  themselves stay un-dimmed for readability.
- When a clause is **visible**, continue scanning its body so nested directives
  are evaluated, and so `#define`/`#undef` update `defined`/`undefed` when
  `definiteScope`.
- Merge adjacent dimmed regions only if it simplifies output; not required.
- Skip emitting empty ranges (clause with no body lines).

**Step 4: Tests — cover every acceptance scenario**

Use small inline HLSL snippets. Required cases:

- **Definitely-defined branch stays visible:** `#define BAR_ON` then
  `#ifdef BAR_ON ... #endif` → no dimmed region over the body.
- **Variant-dependent branch dims:** `#pragma multi_compile _ FOO_ON` then
  `#ifdef FOO_ON ... #endif` → body dimmed with `reason: 'variant'`.
- **`#undef`:** `#define X` … `#undef X` … `#ifdef X` → the later `#ifdef X`
  body dims as `inactive` (X is `FALSE` after the local `#undef`), and a
  following `#ifndef X` stays **visible** (`TRUE`). Separately, `#ifndef X`
  placed *after* `#define X` (before any undef) dims as `inactive`. Add a case
  where X is then re-`#define`'d and `#ifdef X` becomes visible again.
- **Never-seen macro stays visible:** `#ifdef NEVER_SEEN ... #endif` with no
  local define/undef and not a variant keyword → no dimmed region (`UNKNOWN`).
- **`#ifndef` of a defined macro dims** as `inactive`.
- **`#if defined(X)` / `#if !defined(X)`** mirror `#ifdef`/`#ifndef`.
- **`defined(A) && defined(B)`** and **`defined(A) || defined(B)`** with mixed
  defined/variant/unknown operands produce the dim/keep outcomes from the
  `and`/`or` tables.
- **`#else` of a definitely-active `#if`** dims; **`#else` of a variant `#if`**
  dims as `variant`; **`#else` of an all-FALSE chain** stays visible.
- **Nested branches:** a nested `#ifdef` inside a dimmed parent is fully dimmed
  (single region over the parent body); a nested `#ifdef FOO_ON` inside a
  **visible** branch dims only its own variant body.
- **Dimmed parent with nested `#if`/`#else`/`#endif` (boundary regression):** a
  dimmed parent clause whose body contains a complete nested
  `#if … #else … #endif` is emitted as **one** range over the whole parent body,
  and the parent's own `#else`/`#endif` is correctly located at matching depth
  (the nested `#else`/`#endif` is not mistaken for the parent boundary).
- **`mix of && / ||` false-dim guard:** `#if defined(FOO_ON) || defined(NEVER_SEEN)`
  with `FOO_ON` variant stays **visible** (`VARIANT || UNKNOWN → UNKNOWN`),
  while `#if defined(FOO_ON) || defined(X)` after `#undef X` dims as `variant`
  (`VARIANT || FALSE → VARIANT`).
- **Unknown/complex expressions** (`#if SOMETHING_FROM_INCLUDE`, `#if 1`) stay
  visible (no false dimming).
- **ShaderLab:** dimming is computed inside `HLSLPROGRAM`/`CGPROGRAM` blocks and
  reported in file coordinates; directives outside any block are ignored.
- **`HLSLINCLUDE` variant → `HLSLPROGRAM` (file-wide variants):** a `.shader`
  with `#pragma multi_compile _ FOO_ON` in an `HLSLINCLUDE` block and
  `#ifdef FOO_ON` in a later `HLSLPROGRAM` block → the program branch dims as
  `variant`.
- **`HLSLINCLUDE` define → `HLSLPROGRAM` (include-seeded state):** `#define BAR_ON`
  in an `HLSLINCLUDE` block makes a later `HLSLPROGRAM`'s `#ifndef BAR_ON` dim as
  `inactive` and `#ifdef BAR_ON` stay visible; a `#define` made *inside one*
  `HLSLPROGRAM` does **not** affect a *sibling* `HLSLPROGRAM` (no cross-pass
  leak).

**Step 5: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run tests/parser/preproc
```

Expected: all preproc suites pass.

---

### Task 4: Add Setting And Server LSP Request

**Files:**
- Modify: `unity-shader-nav/shared/src/settings.ts`
- Modify: `unity-shader-nav/server/src/config/settings.ts`
- Create: `unity-shader-nav/server/src/handlers/inactiveRegions.ts`
- Modify: `unity-shader-nav/server/src/server.ts`
- Create: `unity-shader-nav/server/tests/handlers/inactiveRegions.test.ts`
- Modify: `unity-shader-nav/server/tests/config/settings.test.ts`

**Step 1: Extend settings**

In `shared/src/settings.ts`, add to `ExtensionSettings` and `DEFAULT_SETTINGS`:

```ts
dimInactiveBranches: { enabled: boolean; opacity: number };
// default: { enabled: true, opacity: 0.55 }
```

In `server/src/config/settings.ts` `mergeSettings`, merge the new nested object
the same way `findReferences`/`debug` are merged (extend `PartialSettings` and
the return object). Add/extend a `settings.test.ts` case asserting defaults and
partial-override merge for `dimInactiveBranches`.

**Step 2: Define the request protocol shape**

Add to `shared/src/protocol.ts` (this file IS the package entry point — `main`/
`types` resolve to `out/protocol.js`/`out/protocol.d.ts`, and it `export *`s the
other shared modules — so anything declared here is package-exported) a
documented request method name and params/result types:

```ts
import type { Range } from './symbols';

export const INACTIVE_REGIONS_REQUEST = 'unityShaderNav/inactiveRegions';
export type DimReason = 'inactive' | 'variant';
export interface InactiveRegion { range: Range; reason: DimReason; }
export interface InactiveRegionsParams {
  // version lets the client drop stale responses (review P2)
  textDocument: { uri: string; version: number };
}
export interface InactiveRegionsResult {
  version: number;               // echo of the requested document version
  regions: InactiveRegion[];     // carries reason so a future issue can split
                                 // inactive vs variant presentation without
                                 // re-deriving (review P3)
}
```

The protocol carries `reason` per region (not a bare `Range[]`) to match design
decision 3 — v1 renders both reasons identically, but the distinction is already
on the wire. `version` is echoed so the client can discard a response that
arrived after the document moved on.

`Range` (and `Position`) are already defined and exported from
`shared/src/symbols.ts` and re-exported through `protocol.ts` via `export *
from './symbols'` — do NOT add a duplicate. Import it from `./symbols` inside
`protocol.ts` (or just reference the re-exported `Range`); client/server already
consume `@unity-shader-nav/shared`'s `Range`.

**Step 3: Implement the handler**

`registerInactiveRegionsHandler(connection, documents, manager, getSettings,
suspender)` modeled on `registerSemanticTokensHandler`:

- Register `connection.onRequest(INACTIVE_REGIONS_REQUEST, handler)`.
- Echo the requested `params.textDocument.version` back in every result
  (including the early-return / disabled cases) so the client can drop stale
  responses.
- Resolve settings for the document scope; if `dimInactiveBranches.enabled` is
  false, return `{ version, regions: [] }`.
- Resolve the document text via `documents.get(uri)?.getText()` (the analyzer
  only needs text; no index is required — but still gate on
  `workspaceForOrCreateFile` returning a workspace to match existing behavior,
  or skip the workspace lookup since the analyzer is text-only — choose the
  text-only path and document why: dimming is per-document and needs no index).
- Determine `isShaderLab` from the URI with the regex `/\.shader(?:$|[?#])/i`.
  `semanticTokens.ts` has the same check as a private `isShaderLabUri(uri)`
  function but does **not** export it — copy the one-line regex test (or, if you
  prefer to share it, export it from a small util; not required for this issue).
- Run `analyzeInactiveRegions(text, { isShaderLab })`; map `DimmedRegion[]`
  straight to `InactiveRegion[]` (the `{ range, reason }` shape already matches),
  and return `{ version, regions }`.
- Wrap in `suspender.run(...)` like the other handlers (default to
  `{ version, regions: [] }` on the suspender's `null`).

**Step 4: Register in `server.ts`**

Add `import { registerInactiveRegionsHandler } from
'./handlers/inactiveRegions';` and call
`registerInactiveRegionsHandler(connection, documents, manager, (uri) =>
loadSettings(connection, uri), suspender)` next to the other `register*Handler`
calls (after `registerReferencesHandler`). `loadSettings` is already imported in
`server.ts` from `./config` and is used the same way (`loadSettings(connection,
scopeUri)`). The other handlers take `(connection, documents, manager,
suspender)` and resolve settings internally if needed; this handler adds the
`getSettings` callback as the 4th positional arg before `suspender` because it
must gate on `dimInactiveBranches.enabled` per document scope. No `initialize`
capability is needed for a custom `onRequest` method, but add an entry to
`SETTINGS_SECTIONS` forwarding (Task 5) so config changes propagate.

**Step 5: Handler test**

There is **no generic Connection mock helper**; each handler test in
`tests/handlers/` hand-rolls a minimal fake `Connection` that captures the one
registration method the handler under test calls, then invokes the captured
handler directly. Two existing patterns:
- `tests/handlers/documentSymbol.test.ts` fakes `connection.onDocumentSymbol(fn)`
  (capturing `handler`), passes a real `RequestSuspender`, and a fake `manager`
  with `workspaceForOrCreateFile`.
- `tests/handlers/semanticTokens.test.ts` fakes
  `connection.languages.semanticTokens.on(fn)` and decodes the token stream.

Because `registerInactiveRegionsHandler` registers via
`connection.onRequest(INACTIVE_REGIONS_REQUEST, handler)` (a method neither
existing test fakes), the fake `Connection` here must capture
`onRequest(method, fn)` — assert `method === INACTIVE_REGIONS_REQUEST`, stash
`fn`, return `{ dispose() {} }`. Also stub `connection.workspace.getConfiguration`
(used by `loadSettings`) when the handler's `getSettings` calls back through
`loadSettings`; or pass an inline `getSettings` callback returning a fixed
`ExtensionSettings` to avoid the `workspace.getConfiguration` round-trip. Drive
the captured handler with a fake `documents.get(uri)` and a fake `manager` (only
needed if the handler keeps the `workspaceForOrCreateFile` lookup — see Step 3's
text-only decision; if text-only, `manager` can be a minimal stub).
Assert:
- enabled=true returns `regions` with the expected `range` + `reason`
  (`variant`/`inactive`) for a known fixture, and echoes the requested `version`.
- enabled=false returns `{ version, regions: [] }`.
- A `.hlsl` URI analyzes the whole file; a `.shader` URI only inside blocks
  (incl. an `HLSLINCLUDE` pragma/define feeding a later `HLSLPROGRAM`).

**Step 6: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run
```

Expected: server suite passes (analyzer + handler + settings).

---

### Task 5: Render Decorations On The Client

**Files:**
- Create: `unity-shader-nav/client/src/inactiveRegions.ts`
- Modify: `unity-shader-nav/client/src/extension.ts`
- Modify: `unity-shader-nav/client/src/client.ts`
- Modify: `unity-shader-nav/client/package.json`
- (No change needed: `unity-shader-nav/tests/client/package-layout.test.ts` does
  not assert the `contributes.configuration` shape — see Step 4.)

**Step 1: Decoration controller**

Create `client/src/inactiveRegions.ts` exporting
`setupInactiveRegions(client, context)`:

- Create one `TextEditorDecorationType` via `window.createTextEditorDecorationType`
  with these render options, recreated when the opacity setting changes:
  - `opacity: '<value> !important'` — the `opacity` field is injected as inline
    CSS on the decorated range; the `!important` suffix is required so it wins
    against VS Code's own token/theme styles (this is the same mechanism the
    built-in C/C++ "inactive region" dimming uses). `<value>` comes from the
    `unityShaderNav.dimInactiveBranches.opacity` setting (read via
    `workspace.getConfiguration('unityShaderNav').get('dimInactiveBranches.opacity')`).
  - `isWholeLine: true` — so the dim covers the full line width (including
    trailing whitespace and the gutter-to-edge area), not just the character
    span returned by the analyzer. Because the analyzer already emits
    whole-line ranges (`start.character: 0` through the line's content), the
    visual result is a dimmed block of lines.
  - `rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed` so the
    decoration does not stretch when the user types at a region edge before the
    next refresh.
  Note: `opacity` is the only render-option field that actually fades existing
  syntax coloring; setting `color` would instead *replace* the text color and
  fight semantic tokens, so do not use `color` for dimming.
- A `refresh(editor)` that: returns early if the editor's languageId is not
  `shaderlab`/`hlsl` or if `dimInactiveBranches.enabled` is false (clear
  decorations in that case); otherwise captures
  `requestedVersion = editor.document.version` and sends
  `client.sendRequest(INACTIVE_REGIONS_REQUEST, { textDocument: { uri:
  editor.document.uri.toString(), version: requestedVersion } })`. **Stale-guard
  (review P2):** before applying, drop the response if
  `editor.document.version !== requestedVersion` (the doc moved on) — and the
  server echoes `result.version`, so also drop if `result.version !==
  requestedVersion`. Only the latest in-flight request per document may land
  (keep a per-URI "latest requested version" and ignore older completions).
  Then convert `regions[].range` to `vscode.Range[]` and call
  `editor.setDecorations(type, ranges)`. (v1 ignores `regions[].reason` and
  renders all dimmed ranges with the single decoration type.)
- Trigger `refresh` on: `window.onDidChangeActiveTextEditor`,
  `window.onDidChangeVisibleTextEditors`, and a debounced
  `workspace.onDidChangeTextDocument` (≈300 ms) for the affected editor, plus
  once for the active editor at setup. Re-create the decoration type and refresh
  all visible editors on `workspace.onDidChangeConfiguration` for
  `unityShaderNav.dimInactiveBranches`.
- Push all disposables (decoration type + listeners) into
  `context.subscriptions`.

**Step 2: Wire into activation**

In `extension.ts`, after `await client.start()`, call
`setupInactiveRegions(client, context)`.

**Step 3: Forward config changes**

In `client.ts` `SETTINGS_SECTIONS`, add
`'unityShaderNav.dimInactiveBranches.enabled'` and
`'unityShaderNav.dimInactiveBranches.opacity'` so the server is notified (server
gates on the enable flag).

**Step 4: Declare settings in `package.json`**

Add to `contributes.configuration.properties`:

```json
"unityShaderNav.dimInactiveBranches.enabled": {
  "type": "boolean",
  "scope": "resource",
  "default": true,
  "description": "Dim inactive and variant-dependent preprocessor branches in shader/HLSL files."
},
"unityShaderNav.dimInactiveBranches.opacity": {
  "type": "number",
  "scope": "resource",
  "default": 0.55,
  "minimum": 0.1,
  "maximum": 1,
  "description": "Opacity applied to dimmed preprocessor branches (0.1–1)."
}
```

`tests/client/package-layout.test.ts` does **not** assert the
`contributes.configuration` shape — it only checks VSIX packaging/runtime layout
and the root `watch` scripts. So no change to it is required for the two new
settings; leave it untouched.

**Step 5: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
npm run build
```

Expected: client `tsc` + bundle succeed with the new module.

---

### Task 6: Docs, Integration Test, Manual Verify, Commit

**Files:**
- Modify: `docs/architecture.md`
- Create: `docs/adr/0005-conservative-preprocessor-branch-dimming.md`
- Modify: `docs/configuration.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/roadmap.md` (move/annotate the preprocessor-dimming line)
- Modify: `README.md` / `README.zh-CN.md` / `README.ja.md` (one feature line each)
- Optional: integration coverage under `server/tests/index/` or a handler
  integration test if the existing suites have a natural home.

**Step 1: ADR-0005**

Write `docs/adr/0005-conservative-preprocessor-branch-dimming.md` (follow the
ADR-0003 structure: Context / Decision / Why not … / Consequences). Record:
- presentation-only, not variant evaluation; four-valued conservative logic
  where **`UNKNOWN` dominates `VARIANT`** (a branch that might be active via an
  unknown/include macro is never dimmed as variant-only);
- variant keywords from `multi_compile*`/`shader_feature*` pragmas, collected
  **file-wide** for `.shader`;
- local `#undef` is **authoritative `FALSE`** for the rest of the flow; only a
  name that never appeared locally (and isn't a variant keyword) stays `UNKNOWN`
  → visible — bias against false dimming;
- `.shader` preprocessing-unit model: `HLSLINCLUDE`/`CGINCLUDE` blocks seed
  later program blocks' definite define state (matches ADR-0001's "include
  symbols visible to all passes"); program-block defines don't leak across
  passes; **approximations**: multi-`SubShader` scoping and include-block defines
  nested inside conditionals are not modeled exactly;
- merged inactive/variant presentation for v1, but the protocol already carries
  `reason` per region so a later issue can split presentation without
  re-deriving;
- pull request + client decoration delivery (push rejected for first pass), with
  explicit `textDocument.version` echo + client stale-response guard because a
  custom request gets no built-in version handling.

**Step 2: architecture.md**

Update the `handlers` bullet to mention inactive-region dimming, and the
"Preprocessor conditions are not evaluated" line in **Indexing Model** to note
the new presentation-only, conservative branch dimming (navigation/refs still
ignore preprocessor state — link ADR-0005).

**Step 3: configuration.md + CHANGELOG + READMEs**

Document `unityShaderNav.dimInactiveBranches.enabled` / `.opacity` in
`configuration.md`. Add an Unreleased entry to `CHANGELOG.md`
(`feat(issue-22)`). Add one short feature line to each README. Update the
roadmap so preprocessor-aware dimming is reflected as delivered/first-pass.

**Step 4: Full verification**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
npm run build
npm test
```

Expected: build, package-layout, electron integration, and workspace Vitest
suites all pass.

**Step 5: Manual verify (Extension Development Host)**

1. `npm run watch`; wait for `[watch-runtime] build ok`; press F5.
2. Open a `.shader` and, **inside an `HLSLPROGRAM ... ENDHLSL` block** (the
   analyzer ignores directives outside HLSL/CG blocks for `.shader`), put
   `#pragma multi_compile _ FOO_ON` + `#ifdef FOO_ON ... #endif` and
   `#define BAR_ON` + `#ifdef BAR_ON ... #endif`. (Or use a standalone `.hlsl`
   file, where the whole file is analyzed.)
3. Confirm the `FOO_ON` branch body is dimmed at the configured opacity and the
   `BAR_ON` branch is normal.
4. Confirm Go to Definition / Find References / completion are unaffected.
5. Toggle `unityShaderNav.dimInactiveBranches.enabled` off → dimming clears;
   change `.opacity` → dim level updates.

Record the manual-verify result back on issue #22 (per `CLAUDE.md`).

**Step 6: Review diff and commit per-task**

Each implementation Task above should already have produced its own
`feat(issue-22)` / `test(issue-22)` commit as it completed. For the docs Task:

```powershell
cd F:\Project\UnityShaderNav
git add docs/architecture.md docs/adr/0005-conservative-preprocessor-branch-dimming.md docs/configuration.md docs/roadmap.md CHANGELOG.md README.md README.zh-CN.md README.ja.md
git commit -m "docs(issue-22): document preprocessor branch dimming"
```

Ensure no build output under `client/out`, `server/out`, `shared/out`, or
`tests/out` is staged.

---

## Acceptance Criteria Traceability

| Issue acceptance criterion | Covered by |
| --- | --- |
| Recognize file-local `#define`/`#undef` state | Task 2 (`MacroState.defined`/`undefed`; `#undef`→`FALSE`), Task 3 (`definiteScope`, include-seeded base) |
| `multi_compile*` / `shader_feature*` pragmas → variant keywords | Task 1 |
| Definitely-defined branch stays visible | Task 3 (`TRUE`→VISIBLE) + test |
| Variant-dependent branch dims | Task 3 (`VARIANT`→DIM) + test |
| `#ifdef`/`#ifndef`/`#if defined`/`#if !defined` + optional `&&`/`||` | Task 2 |
| Unknown/complex handled conservatively (no compiler-accurate claim) | Task 2 (`UNKNOWN`), Task 3 (visible), ADR-0005 |
| Presentation only; navigation/refs/completion untouched | Task 4/5 (decorations), Task 6 manual verify |
| Tests for defines/`#undef`/variant/nested/else | Task 3 Step 4 |

## Non-Goals (restated from the issue, enforced by the plan)

No full C preprocessor expansion, no Unity variant enumeration, no material/
global keyword reading, no platform/backend define modeling, no URP/HDRP define
simulation, no cross-file include-chain macro precision (cross-`#include` macros
stay `UNKNOWN` → visible). Within a `.shader`, same-file `HLSLINCLUDE`/`CGINCLUDE`
→ program define/pragma propagation **is** handled (see design decision 5), but
precise multi-`SubShader` scoping and include-block defines nested inside
conditionals are approximated, not exact.

---

## Plan Authoring Commit

When writing or revising this plan file before implementation, commit only:

```powershell
cd F:\Project\UnityShaderNav
git add docs/plans/2026-05-27-issue-22-dim-inactive-preprocessor-branches.md
git commit -m "docs(issue-22): plan preprocessor branch dimming"
```

The per-task `feat`/`test`/`docs(issue-22): document ...` commits are for the
future execution of this plan, not for this plan-writing change.

---

## Review Notes (Codex, 2026-05-28)

> **Resolution (2026-05-28, all notes评估后采纳):** 全部 7 条经核对均成立(P1 的
> HLSLINCLUDE 论据已对照 ADR-0001 第 26 行确认;`contentEndLine` inclusive 已对照
> `fileIndexer.ts` / `tokenScanner.ts` 确认),已并入计划:
> - **P1 `#undef`** → `MacroState` 增加 `undefed` 集,`#undef X` 后 `#ifdef X`
>   判为 `FALSE`(dim)、`#ifndef X` 判为 `TRUE`(visible)。见设计决策 4、Task 2、
>   Task 3。
> - **P1 `||` false-dim**(及对称的 `&&`)→ 四值逻辑改为 **`UNKNOWN` 优先于
>   `VARIANT`**;`VARIANT || UNKNOWN`/`VARIANT && UNKNOWN` 均判 `UNKNOWN`(保持
>   可见)。见 Task 2 的 and/or 表。
> - **P1 HLSLINCLUDE** → 新增设计决策 5:variant keyword **全文件收集**,程序块的
>   define 状态由其前序 `HLSLINCLUDE`/`CGINCLUDE` 块**种子注入**;多 SubShader /
>   include 内条件 define 标注为近似(写入 ADR-0005 与 Non-Goals)。见 Task 3 Step 1
>   + 两个新回归测试。
> - **P2 `contentEndLine` inclusive** → Context + Task 3 明确 inclusive 与
>   `slice(.., end + 1)`。
> - **P2 version/stale** → 协议 params/result 带 `textDocument.version`,server
>   回传、client 落 decoration 前校验且只允许最后一次响应生效。见设计决策 1、
>   Task 4 Step 2/3、Task 5 Step 1。
> - **P2 dimmed body depth scan** → Task 3 Step 3 明确跳过 dimmed body 时仍按
>   `#if`/`#endif` 深度计数寻找同级边界 + 新增「dimmed parent 含嵌套 if/else/endif」
>   回归测试。
> - **P3 protocol 保留 reason** → `InactiveRegionsResult.regions` 改为
>   `{ range, reason }[]`,v1 客户端仍统一渲染。见 Task 4 Step 2。


- **P1 - `#undef` 的语义过于保守，和 issue #22 的验收项有冲突。** 计划现在明确要求 `#define X` 后 `#undef X`，再遇到 `#ifdef X` 时返回 `UNKNOWN` 并保持可见。但 issue 的验收项是“recognizes simple file-local `#define` and `#undef` state while scanning a shader/HLSL preprocessing flow”。在同一个预处理流里，本地 `#undef X` 后、下一次本地 `#define X` 前，`X` 应该是确定未定义；`#ifdef X` 应 dim 为 inactive，`#ifndef X` 应保持可见。建议把宏状态从单个 `defined: Set<string>` 扩展成三态/双集合：`defined` + `locallyUndefed`（或 `Map<name, 'defined' | 'undefed'>`）。仅对“从未在本地出现过”的名字返回 `UNKNOWN`；对本地 `#undef` 过且未重新定义的名字返回 `FALSE`。

- **P1 - `defined(A) || defined(B)` 的四值逻辑会 false-dim。** 当前 OR 规则是“没有 TRUE、没有全 FALSE、只要有 VARIANT 就返回 VARIANT”。这会让 `defined(VARIANT_KEYWORD) || defined(UNKNOWN_FROM_INCLUDE)` 返回 `VARIANT` 并 dim，但 `UNKNOWN_FROM_INCLUDE` 可能在真实编译流里为 true，此时整个分支并不依赖 variant。保守 OR 应该把 `VARIANT || UNKNOWN` 视为 `UNKNOWN`（保持可见）；只有 `VARIANT || FALSE`、`VARIANT || VARIANT` 这类所有非-variant 输入都确定为 false 的组合，才可以返回 `VARIANT`。

- **P1 - `.shader` 按 block 独立分析会漏掉 `HLSLINCLUDE` 到 Pass 的预处理上下文。** 计划说对 `.shader` 每个 HLSL/CG block 单独收集 pragma 和宏状态，但 ADR-0001 已记录 `HLSLINCLUDE` 块内符号对后续 Pass 可见；Unity 的实际作者心智里，`HLSLINCLUDE` 里的 shared code/宏也会影响后续 program block。这样会漏掉至少两类用例：`HLSLINCLUDE` 里 `#pragma multi_compile _ FOO_ON`，后续 `HLSLPROGRAM` 里 `#ifdef FOO_ON` 不会被识别为 variant；`HLSLINCLUDE` 里 `#define BAR_ON`，后续 `#ifndef BAR_ON` 也不会 dim。建议明确 `.shader` 的“预处理流/编译单元”模型，并增加跨 `HLSLINCLUDE` -> `HLSLPROGRAM` 的测试；如果第一版故意不支持，也应写进 Non-Goals/ADR，避免实现者按当前描述误判为已覆盖。

- **P2 - `contentEndLine` 是 inclusive，计划文字容易诱发 off-by-one。** 当前 `scanBlocks` 和 `fileIndexer` 的真实用法是 `lines.slice(block.contentStartLine, block.contentEndLine + 1)`，并且测试断言 `contentStartLine <= line <= contentEndLine`。计划的 Context 里写“exclusive of the directive lines”可以理解，但 Task 3 的 `contentStartLine..contentEndLine` 没有强调 inclusive。建议直接写明：`contentEndLine` 是最后一行内容的 0-based inclusive 行号；如果用 `slice`，end 必须是 `contentEndLine + 1`。

- **P2 - 自定义 request 缺少 document version / stale-response 处理。** 计划说 pull request “version handling for free”，但 `unityShaderNav/inactiveRegions` 不是标准 semantic tokens 请求，参数也只有 URI。用户快速编辑时，较旧请求可能晚于较新请求返回并覆盖 decorations。建议在 params 里带 `textDocument.version`，server 回传它，client 应用 decorations 前检查 `editor.document.version` 仍匹配；或至少在 client 维护 per-document request sequence，只允许最后一次响应落地。

- **P2 - “dimmed clause 不 descend” 仍需要扫描嵌套 directive 深度。** 计划说 dimmed clause 发出整段 range，且不进入其嵌套 directive。实现时仍必须 lexical-scan 这段 body 里的 `#if/#endif` depth，才能找到当前 frame 对应的同级 `#elif/#else/#endif`。否则 dimmed 父分支里出现嵌套 `#if ... #else ... #endif` 时，walker 很容易把嵌套的 `#else/#endif` 当成父分支边界。建议把这点写成算法步骤，并加一个“dimmed parent contains nested if/else/endif”的回归测试。

- **P3 - protocol 结果只传 `Range[]`，和“保留 reason 方便未来拆 presentation”的理由不完全一致。** analyzer 内部有 `reason: 'inactive' | 'variant'`，但 Task 4 的 `InactiveRegionsResult` 丢掉了 reason。第一版统一样式当然可以只用 ranges；不过如果设计理由是未来不用重新推导即可拆分 inactive/variant 样式，建议现在就让协议返回 `{ range, reason }[]`，client 第一版仍统一渲染即可。否则就把“未来 split 不用 re-derive”改成“server analyzer 已保留 distinction，未来需要扩展协议”。
