# Review Notes (independent reviewer, 2026-05-28)

**Verdict: ready after P1 fixes.** The plan's overall architecture is sound and
the API/symbol shape claims are accurate where they matter most. However, two
concrete claims contradict the code (`workspace.rootUri` field name;
"definition returns null for empty member resolution") and would make the
implementation either fail to compile or behave differently from the existing
definition handler. Several P2/P3 items refine path conventions, harness
location, and edge cases. Fix the P1s and the plan is ready to execute.

---

- **P1 — `workspace.rootUri` does not exist; the field is `folderUri`.** The
  plan uses `workspace.rootUri` in design decision 5 ("If `workspace.rootUri`
  is known the path is made workspace-relative") and in task 2 step 7
  (`workspaceRootUri: workspace.rootUri`). In
  `unity-shader-nav/server/src/workspace/workspace.ts:34`, the public field is
  `readonly folderUri: string`; there is no `rootUri` anywhere in the
  workspace module (grep shows only `folderUri` and `workspaceFolderUri`).
  The hover handler will not compile. Rename every `workspace.rootUri`
  reference in the plan (and the formatter's `workspaceRootUri` input) to
  `workspace.folderUri`, or rename only the call-site (`workspaceRootUri:
  workspace.folderUri`) and keep the formatter's parameter name
  `workspaceRootUri` for clarity.

- **P1 — "definition returns `null` for empty member resolution" is false;
  `definition.ts` falls through to plain-word resolution.** Plan task 2 step 7
  states: *"when member resolution returns empty, return `null` rather than
  falling through. (Definition also returns `null` for empty member resolution
  at this position.)"* But
  `unity-shader-nav/server/src/handlers/definition.ts:130-150` clearly drops
  out of the `if (links.length > 0)` block, logs `member.result { links: 0 }`,
  and then unconditionally proceeds to `const word = wordAt(...)` and
  `resolveDefinition(...)`. So definition does *not* return null on empty
  member resolution — it falls through. If hover deliberately diverges, the
  parenthetical justification is wrong and the divergence itself becomes a
  behavior gap with definition (acceptance criterion 3 says hover respects
  the *same* visibility rules — most users will read that as "same overall
  resolution behavior"). Either restate this as a deliberate divergence and
  explain why (e.g. "hover on `s.foo` when `foo` is unresolved should not
  silently hover whatever `foo` happens to be as a free identifier"), or
  align with definition by falling through. Recommend aligning: keep parity
  unless there's a UX reason not to.

- **P2 — Hand-rolled `decodeURIComponent` instead of `fileURLToPath` for the
  source footer.** Plan design decision 5 and task 1 step 1 use
  `decodeURIComponent` on the URI's path component. The repo already uses
  `fileURLToPath` from `node:url` (see
  `unity-shader-nav/server/src/workspace/workspace.ts:64`,
  `unity-shader-nav/server/src/workspace/workspaceManager.ts:71`, and several
  others). `fileURLToPath` correctly decodes the URI *and* fixes the leading
  slash on Windows drive letters (`file:///F:/...` → `F:\...`). Hand-rolled
  `decodeURIComponent` will keep the URL slash and produce display strings
  like `/F:/Project/...:42`. Recommend using `fileURLToPath(uri)` then
  stripping `workspace.folderUri`-as-path prefix, falling back to `basename`.

- **P2 — Integration test path `unity-shader-nav/tests/electron/` does not
  exist.** Plan task 3 creates `unity-shader-nav/tests/electron/hover.test.ts`
  and references "the existing electron test bootstrap" under
  `tests/electron/`. The actual integration tests live under
  `unity-shader-nav/tests/integration/client/` (e.g. `definition.test.ts`,
  `completion.test.ts`, `signature-help.test.ts`) and use Mocha `suite/test`
  with the `withWorkspaceFolder` helper at
  `tests/integration/client/helpers/workspace.ts`. Recommend retargeting task
  3 to `unity-shader-nav/tests/integration/client/hover.test.ts`, mirroring
  the `definition.test.ts` shape (including the `waitForDefinitions`-style
  polling loop — hover requests can race the indexer on cold open just like
  definition).

- **P2 — `isGenericDefinitionContext` is more than a "comment/string guard";
  it also enforces "inside HLSL block" for `.shader` files.** Plan context
  bullet says: *"`isGenericDefinitionContext` … is what `definition.ts` uses
  to reject hovers in comments / strings / non-shader code."* That undersells
  it. `unity-shader-nav/server/src/parser/lexical/context.ts:81-86` *also*
  rejects positions inside a `.shader` file that are outside any
  `HLSLPROGRAM`/`HLSLINCLUDE`/`CGPROGRAM`/`CGINCLUDE` block — that is,
  hovering in the ShaderLab declarative section (Properties, SubShader header,
  Pass header lines outside HLSL blocks) will return null. That is the
  correct hover behavior for v1, but the plan should call this out
  explicitly so a reader does not file a "hover broken on ShaderLab `Tags {
  "Queue"="Transparent" }`" bug as a regression. Tighten the bullet and add
  one test case "hover inside ShaderLab declarative section outside any HLSL
  block → null".

- **P2 — Edge case missing: hovering the declaration itself.** When the cursor
  is on the identifier of the declaration (e.g. on `Helper` in `float4
  Helper(...) { ... }`), `resolveDefinitionSymbols` returns the same symbol
  whose `location.range` *is* the cursor's word range. Hover will produce a
  card describing the symbol as if you were hovering a *use* of it. That is
  mostly fine — VS Code's own TypeScript hover behaves the same — but the
  plan should decide explicitly. Options: (a) accept it (current implicit
  behavior), (b) suppress when the cursor lies inside `symbol.location.range`
  for the single-candidate case. Recommend (a) with one test pinning the
  behavior so a future change is intentional.

- **P3 — Cap of 5 is plan-introduced; ADR-0001 does not specify a cap.** Plan
  design decision 3 caps multi-candidate hover at 5 and cites ADR-0001 for
  the multi-candidate convention. ADR-0001
  (`docs/adr/0001-multi-candidate-peek-for-ambiguous-symbols.md`) only says
  "return `Definition[]` and let Peek pick"; it does not bound the array. The
  definition path therefore returns *all* candidates and Peek shows them all.
  Hover cannot use Peek so a cap is reasonable, but the rationale should be
  "hover MarkupContent payload size" rather than "matches ADR-0001". Either
  tweak the rationale wording, or — better — add a one-line note to ADR-0001
  (or a small follow-up ADR) recording the hover-specific cap so this number
  doesn't get questioned in code review.

- **P3 — Markdown injection on the prose lines outside the fence.** The plan's
  `_member of_ \`${parentType}\`` line and `_in_ ${path}:${line+1}` footer
  live outside the fenced ` ```hlsl ` block. Underscores adjacent to
  alphanumerics in paths (e.g.
  `Packages/com.unity.render-pipelines.core/Runtime/Common/Common_Macros.hlsl`)
  generally do not trigger italic in CommonMark since underscore italics
  require word-boundary, but `Foo _ Bar.hlsl` (rare) would. More concretely,
  the `_in_` and `_member of_` markers themselves rely on the surrounding
  whitespace being preserved exactly; if the formatter accidentally produces
  `_in_${path}` (no space) the parser will not italicize the marker but the
  line will still render. Recommend either wrapping the marker in `*…*`
  (asterisks are unambiguous) or making the path itself a backtick-quoted
  inline code span: `_in_ \`${relativePath}\`:${line + 1}` — backticks
  neutralize all markdown inside them and also visually distinguish the path
  from prose.

- **P3 — Built-in catalog footer category text leaks an internal enum
  value.** The plan emits `_built-in (${entry.category})_` where `category` is
  one of `'hlsl' | 'unitycg' | 'urp' | 'shaderlab' | 'semantic'` (see
  `unity-shader-nav/server/src/suggestions/builtins/types.ts:3`). `urp` and
  `unitycg` are recognizable to Unity authors, but `semantic` as a category
  label on `_built-in (semantic)_` for `POSITION` is redundant (the kind is
  `semantic` too) and reads oddly. Minor — recommend a small lookup mapping
  category → human label (e.g. `unitycg → "Unity built-in"`, `urp → "URP"`,
  `semantic → "HLSL semantic"`).

- **P3 — `BUILTIN_ENTRIES` uniqueness is currently real but not enforced.**
  Plan task 2 step 11 says "Built-in matches are typically unique on name,
  but the formatter handles arrays anyway." Inspecting
  `unity-shader-nav/server/src/suggestions/builtins/catalog.ts` confirms zero
  duplicates today. There is no `unique`/`Set` enforcement in the catalog or
  its loader, so future additions could introduce duplicates silently (e.g. a
  `POSITION` semantic and a hypothetical `POSITION` macro). This is fine —
  the formatter handles arrays — but worth a one-line note in `Non-Goals`
  that hover will render *all* matching catalog entries stacked if duplicates
  ever appear, rather than picking one.

- **No issue found** on the following points the review prompt asked to
  check:
  - API claims: `resolveDefinitionSymbols` and `resolveMemberSymbols` are
    exported from `unity-shader-nav/server/src/index/index.ts` (lines 4-5)
    with signatures matching the plan's call sites.
  - `SymbolEntry` / `FunctionSymbolEntry` carry `declaredType`, `parentType`,
    `returnType`, `parameters`, `location.range` exactly as the formatter
    expects (`shared/src/symbols.ts:16-36`).
  - `BuiltinEntry` shape matches what the built-in formatter reads (`name`,
    `kind`, `category`, `detail?`, `documentation?`, `returnType?`,
    `parameters?`) — `server/src/suggestions/builtins/types.ts:7-16`.
  - The fake `Connection` capturing `connection.onDefinition` is exactly the
    pattern used in `definition.test.ts:21-29`; the same pattern works
    verbatim for `onHover`. The cross-file include test is also directly
    demonstrated in the existing test (`definition.test.ts:115-195`) so task
    2's "Cross-file via include" case is fully supported by the existing
    harness.
  - Adding `hoverProvider: true` in `createInitializeResult` is sufficient
    client-side; `vscode-languageclient` auto-wires hover as a default LSP
    feature, and the existing `client/src/client.ts` does no per-capability
    registration that would need updating.
  - The `registerHoverHandler(connection, documents, manager, suspender)`
    signature is consistent with the other `register*Handler` helpers in
    `server.ts:81-99`.
  - Project-shadows-builtin merge order matches
    `mergeProjectAndBuiltinSuggestions` in `handlers/completion.ts:20-33`.
