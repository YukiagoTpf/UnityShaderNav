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
  exposes `contentStartLine`/`contentEndLine` (0-based, exclusive of the
  directive lines: `startLine+1 .. endLine-1`), confirmed present. The scanner
  is comment-aware. Standalone `.hlsl`/`.cginc`/`.compute` files are all-HLSL.
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
   `RequestSuspender` and version handling for free and avoids wiring a push
   into the `reindex` pipeline. Server push (like `unityShaderNav/mode`) was
   considered and rejected for the first pass to keep the change localized.
2. **Client decorations, not semantic-token modifiers.** Only decorations can
   dim a whole region (including comments/blank lines/nested directives) at a
   configurable opacity. This is also how Rider/C++ "inactive region" dimming
   works.
3. **First pass merges "definitely inactive" and "variant-dependent" into one
   dimmed presentation**, as the issue allows. The analyzer still tracks the
   distinction internally (`reason: 'inactive' | 'variant'`) so a later issue
   can split the presentation without re-deriving it.
4. **Conservatism = bias against false dimming.** A guard macro that is neither
   locally defined nor a known Unity variant keyword is treated as `UNKNOWN`
   and left **visible** (it may be defined in an unscanned include). We only dim
   branches we can justify: definitely-false branches and variant-gated
   branches. This honors the "handled conservatively" acceptance criterion and
   the cross-file non-goal.

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
  variants: ReadonlySet<string>;  // Unity variant keywords from pragmas
}
```

`evalDefined(name, state): CondValue`:
- `state.defined.has(name)` → `TRUE`
- else `state.variants.has(name)` → `VARIANT`
- else → `UNKNOWN` (never `FALSE` from absence — could come from an include)

`#undef` removes a name from `defined`; a subsequently-checked `#ifdef` on an
undef'd-and-never-variant name therefore evaluates `UNKNOWN`, not `FALSE`
(conservative). `FALSE` arises from negation of a `TRUE` atom (e.g. `#ifndef X`
after `#define X`), not from absence.

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

Four-valued logic helpers (kept conservative):

```
not:   TRUE→FALSE, FALSE→TRUE, VARIANT→VARIANT, UNKNOWN→UNKNOWN

and:   FALSE if any operand FALSE
       else TRUE if all operands TRUE
       else VARIANT if any operand VARIANT
       else UNKNOWN

or:    TRUE if any operand TRUE
       else FALSE if all operands FALSE
       else VARIANT if any operand VARIANT
       else UNKNOWN
```

Keep the expression parser deliberately small: tokenize on `defined`, `(`, `)`,
`!`, `&&`, `||`, and identifiers. If parsing hits any token outside this set, or
mixes `&&` with `||` in a way the small parser does not model, return `UNKNOWN`.
Do not implement a general C expression evaluator.

**Step 2: Tests**

Table-driven over `CondValue` outcomes:

- `defined`/`variant`/`unknown`/`undef`'d name across `ifdef`/`ifndef`/
  `if defined`/`if !defined`.
- `defined(A) && defined(B)` with combinations of TRUE/VARIANT/UNKNOWN/FALSE
  operands → matches the `and` table.
- `defined(A) || defined(B)` likewise → matches the `or` table.
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

For `.shader`, run `scanBlocks(text)` and analyze each block's content range
(`contentStartLine..contentEndLine`), offsetting line numbers into file
coordinates. For HLSL files, analyze the whole text as one region. `#pragma`
variant keywords are collected per analyzed region via `scanVariantKeywords` on
that region's text (so block-local pragmas apply to that block); for the
whole-file HLSL case it is the whole file.

**Step 2: Branch walk algorithm**

Walk lines top-to-bottom (comment-aware, reuse the shared strip helper).
Maintain:

- `defined: Set<string>` — definite macros. Seeded empty.
- `variants: Set<string>` — from Task 1.
- A stack of branch frames. Each frame records, for the currently-open clause:
  `dimmed: boolean`; `clauseDefinite: boolean` (this open clause is *definitely*
  active — i.e. it was entered with `CondValue == TRUE` from a `NONE_TAKEN`
  chain, or it is an `#else`/`#elif` whose chain proves it definite); chain
  bookkeeping `state ∈ { NONE_TAKEN, DEFINITELY_TAKEN, VARIANT_PENDING,
  UNKNOWN_PENDING }`; and the body start line.
- `definiteScope: boolean` — derived as "the stack is empty (top level) OR every
  open frame has `clauseDefinite === true`." Only `#define`/`#undef` directives
  encountered while `definiteScope` is true mutate `defined`. Crucially,
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
  `#endif`. Do **not** descend into a dimmed clause's nested directives; the
  whole body (including any nested `#if`/comments/blank lines) is dimmed as one
  range. This makes nesting fall out for free and keeps directive lines
  themselves un-dimmed for readability.
- When a clause is **visible**, continue scanning its body so nested directives
  are evaluated, and so `#define`/`#undef` update `defined` when `definiteScope`.
- Merge adjacent dimmed regions only if it simplifies output; not required.
- Skip emitting empty ranges (clause with no body lines).

**Step 4: Tests — cover every acceptance scenario**

Use small inline HLSL snippets. Required cases:

- **Definitely-defined branch stays visible:** `#define BAR_ON` then
  `#ifdef BAR_ON ... #endif` → no dimmed region over the body.
- **Variant-dependent branch dims:** `#pragma multi_compile _ FOO_ON` then
  `#ifdef FOO_ON ... #endif` → body dimmed with `reason: 'variant'`.
- **`#undef`:** `#define X` … `#undef X` … `#ifdef X` → body of the later
  `#ifdef X` is **visible** (UNKNOWN after undef, conservative), while
  `#ifndef X` after `#define X` (before undef) dims as `inactive`.
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
- **Unknown/complex expressions** (`#if SOMETHING_FROM_INCLUDE`, `#if 1`) stay
  visible (no false dimming).
- **ShaderLab:** dimming is computed inside `HLSLPROGRAM`/`CGPROGRAM` blocks and
  reported in file coordinates; directives outside any block are ignored.

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
export interface InactiveRegionsParams { textDocument: { uri: string }; }
export interface InactiveRegionsResult { regions: Range[]; }
```

`Range` (and `Position`) are already defined and exported from
`shared/src/symbols.ts` and re-exported through `protocol.ts` via `export *
from './symbols'` — do NOT add a duplicate. Import it from `./symbols` inside
`protocol.ts` (or just reference the re-exported `Range`); client/server already
consume `@unity-shader-nav/shared`'s `Range`.

**Step 3: Implement the handler**

`registerInactiveRegionsHandler(connection, documents, manager, getSettings,
suspender)` modeled on `registerSemanticTokensHandler`:

- Register `connection.onRequest(INACTIVE_REGIONS_REQUEST, handler)`.
- Resolve settings for the document scope; if `dimInactiveBranches.enabled` is
  false, return `{ regions: [] }`.
- Resolve the document text via `documents.get(uri)?.getText()` (the analyzer
  only needs text; no index is required — but still gate on
  `workspaceForOrCreateFile` returning a workspace to match existing behavior,
  or skip the workspace lookup since the analyzer is text-only — choose the
  text-only path and document why: dimming is per-document and needs no index).
- Determine `isShaderLab` from the URI with the regex `/\.shader(?:$|[?#])/i`.
  `semanticTokens.ts` has the same check as a private `isShaderLabUri(uri)`
  function but does **not** export it — copy the one-line regex test (or, if you
  prefer to share it, export it from a small util; not required for this issue).
- Run `analyzeInactiveRegions(text, { isShaderLab })`, map `DimmedRegion[]` to
  `regions: Range[]`, return `{ regions }`.
- Wrap in `suspender.run(...)` like the other handlers.

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
- enabled=true returns variant/inactive ranges for a known fixture.
- enabled=false returns `{ regions: [] }`.
- A `.hlsl` URI analyzes the whole file; a `.shader` URI only inside blocks.

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
  decorations in that case); otherwise sends
  `client.sendRequest(INACTIVE_REGIONS_REQUEST, { textDocument: { uri:
  editor.document.uri.toString() } })`, converts `regions` to `vscode.Range`,
  and calls `editor.setDecorations(type, ranges)`.
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
- presentation-only, not variant evaluation; four-valued conservative logic;
- variant keywords from `multi_compile*`/`shader_feature*` pragmas;
- UNKNOWN (incl. cross-file) stays visible — bias against false dimming;
- merged inactive/variant presentation for v1 with internal `reason` retained;
- pull request + client decoration delivery (push rejected for first pass).

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
| Recognize file-local `#define`/`#undef` state | Task 2 (`MacroState`, undef), Task 3 (`definiteScope`) |
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
simulation, no cross-file include-chain macro precision (cross-file macros stay
`UNKNOWN` → visible).

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
