# Hover Information For Shader Symbols Implementation Plan

> **For Claude:** Implement this plan task-by-task. Execute one Task, then commit
> one `feat(issue-18)` / `test(issue-18)` commit before starting the next, per
> `CLAUDE.md` 执行纪律. The plan-authoring commit (`docs(issue-18)`) is separate
> and described at the end.

**Goal:** Add conservative hover information (LSP `textDocument/hover`) for
indexed Unity shader symbols so a reader can inspect a declaration-style summary
and source location without leaving the current file. v1 covers project
functions, structs, struct members, variables (globals/uniforms/cbuffer
members), parameters, local variables, macros, and selected built-ins that have
catalog entries — all subject to the same local-scope and include-visibility
rules already used by `textDocument/definition` and completion.

**Architecture:** A new LSP handler `handlers/hover.ts` that mirrors the
existing `handlers/definition.ts` request shape: resolve workspace, ensure the
file index exists, derive a `WordAt` / `MemberAccess` for the cursor, reuse
`resolveDefinitionSymbols` / `resolveMemberSymbols` (the *Symbols* variants —
not the `LocationLink` variants used by go-to-definition) to pick visible
project candidates, fall back to the existing built-in catalog
(`BUILTIN_ENTRIES`) for non-project names. A new pure formatter
`server/src/hover/format.ts` turns a `SymbolEntry` or `BuiltinEntry` into a
markdown `Hover` payload. The handler never modifies the index, never evaluates
preprocessor branches, and never claims one of multiple candidates is
authoritative when more than one survives visibility filtering.

**Tech Stack:** TypeScript, npm workspaces (`shared` / `server` / `client`),
`vscode-languageserver` (server), `vscode-languageclient` (already auto-binds
hover when the server advertises `hoverProvider: true`), Vitest (server unit
tests), Mocha + `@vscode/test-electron` (client/integration). Existing modules
reused: `index/symbolResolver.resolveDefinitionSymbols`,
`index/chainLookup.resolveMemberSymbols`, `index/wordAt`, `index/visibility`,
`suggestions/builtins/catalog`, `parser/lexical/context.isGenericDefinitionContext`.

---

## Context

Current state (verified against the tree):

- `server/src/handlers/definition.ts` is the closest pattern: it resolves the
  workspace, reindexes on miss, checks `isGenericDefinitionContext`, collects
  visible URI keys, branches on `memberAccessAt`, falls back to `wordAt`, then
  calls `resolveMember` / `resolveDefinition` (the `LocationLink[]` variants).
  Hover needs the *underlying symbols* instead of locations, so it should call
  the `*Symbols` siblings already exported from `server/src/index/index.ts`:
  `resolveDefinitionSymbols` and `resolveMemberSymbols`. Both already apply the
  same scope / visibility / global filtering as the location variants.
- Symbol shape (`shared/src/symbols.ts`): every `SymbolEntry` carries
  `name`, `kind` (`'function' | 'variable' | 'parameter' | 'localVariable' |
  'struct' | 'structMember' | 'macro' | 'cbuffer'`), `location.{uri,range}`,
  optional `declaredType`, optional `parentType`, optional `scopeRange`.
  `FunctionSymbolEntry` additionally carries `returnType` and
  `parameters: FunctionParameter[]` (`{ name, type, range }`).
- The existing `signatureLabelOf(suggestion)` in
  `server/src/suggestions/format.ts` already formats a function signature as
  `${returnType} ${name}(${params})` — the hover formatter can call it
  indirectly by going `symbolToSuggestion` → `signatureLabelOf`, OR build the
  same string directly off `FunctionSymbolEntry` to avoid the suggestion
  detour. The plan prefers a small direct formatter in `hover/format.ts` so the
  hover payload does not depend on the `ShaderSuggestion` shape.
- Built-in catalog: `server/src/suggestions/builtins/catalog.ts` exports
  `BUILTIN_ENTRIES: readonly BuiltinEntry[]` (`{ name, kind, category, detail?,
  documentation?, returnType?, parameters? }`). The hover formatter can read
  `documentation` and `detail` straight off this catalog.
- Visibility: `collectVisibleUriKeys(store, includeCtx, uri)` returns the URI
  key set the symbol resolver expects in `ResolutionOptions.visibleUriKeys`.
  Re-use as-is.
- Lexical guard: `isGenericDefinitionContext(text, position, languageId, uri)`
  in `server/src/parser/lexical/context.ts` is what `definition.ts` uses to
  reject definition requests. It returns `false` in two distinct cases:
  (a) the cursor is in a `//` or `/* */` comment or inside a string literal
  (via `lexicalContextAt`), AND (b) the cursor is in a `.shader` file but
  **outside** every `HLSLPROGRAM`/`HLSLINCLUDE`/`CGPROGRAM`/`CGINCLUDE` block
  (via `isShaderLabDocument` + `isInsideShaderLabHlslBlock`). So hover in the
  ShaderLab declarative section (Properties block, SubShader/Pass header
  lines, `Tags { ... }`) also returns `null`. This is correct v1 behavior
  (issue 18 is scoped to indexed shader symbols, not ShaderLab keywords) but
  call it out so a future "hover broken on `Tags`" report is not misfiled.
  Reuse the function as-is.
- Initialize: `server/src/connection.ts` `createInitializeResult` returns the
  capability advertisement. Adding hover requires `hoverProvider: true`.
- Settings: `shared/src/settings.ts` (`ExtensionSettings` / `DEFAULT_SETTINGS`),
  merged in `server/src/config/settings.ts` `mergeSettings` with nested
  `findReferences` / `debug` / `dimInactiveBranches` groups. Hover is
  always-on in v1 — no new setting is introduced (debate this in design
  decision 6).
- Handler test pattern: `server/tests/handlers/definition.test.ts` is the
  closest test for a `connection.onX(handler)` style handler — it fakes
  `Connection`, wires a fake `WorkspaceManager`, and drives the captured
  handler directly. Hover should follow this same pattern with
  `connection.onHover`.
- Client integration: there is no client-side hover code today; once the server
  advertises `hoverProvider`, `vscode-languageclient` wires VS Code's built-in
  hover UI automatically. The existing client integration test rig under
  `unity-shader-nav/tests/electron/` is the place to add one
  `vscode.executeHoverProvider` smoke test.

### Design decisions (rationale; reviewers may sharpen)

1. **Reuse `resolveDefinitionSymbols` / `resolveMemberSymbols`, do not invent a
   new resolver.** Hover and definition share the same visibility model
   (acceptance criterion 3), so any divergence is a bug. The `*Symbols`
   variants are already exported and already used by `referenceResolver.ts` —
   no new public API is added in the index module.
2. **No preprocessor-aware filtering.** Issue 18 explicitly inherits the
   navigation model: preprocessor conditions are not evaluated. ADR-0005
   covers presentation-only dimming and does not change index results. Hover
   reuses the same index, so it must not pretend one of two
   `#ifdef`-gated candidates is the "real" one.
3. **Multi-candidate presentation = stacked.** When
   `resolveDefinitionSymbols` returns more than one survivor after scope and
   visibility filtering, hover renders them stacked in the same `MarkupContent`
   with a `---` separator and a small `(N candidates)` header. This honors the
   same "don't pick a winner" spirit as ADR-0001 "multi-candidate peek for
   ambiguous symbols" — definition uses the Peek UI to show every candidate;
   hover concatenates instead because there is no Peek UI in a hover bubble.
   **Cap at 5 entries** to bound MarkupContent payload size (a hover bubble
   with 20+ candidates is unreadable, not because ADR-0001 says so — it
   doesn't); append a final `… and M more candidates` line when truncated. If
   the cap ever needs to change, record it as a small follow-up ADR rather
   than retconning ADR-0001.
4. **Markdown, not plain text.** Return
   `{ contents: { kind: MarkupKind.Markdown, value } }`. Code blocks are fenced
   with ` ```hlsl ` so VS Code applies HLSL syntax highlighting to the
   declaration line — this is what makes hover read like a header file
   declaration rather than a raw string.
5. **Source-location footer, no extra disk I/O.** The footer is a single line
   ``_in_ `path/relative/to/folder.ext`:line`` rendered from
   `symbol.location.uri` + `+1` for human-readable line numbers. The URI is
   converted to a filesystem path via `fileURLToPath` from `node:url`
   (already used in `workspace/workspaceManager.ts:71`) — **not**
   hand-rolled `decodeURIComponent`, which would leave the leading slash on
   Windows drive letters (`/F:/...`). If `workspace.folderUri` (the actual
   public field; there is no `rootUri`) is known, the path is made
   workspace-relative by stripping `fileURLToPath(workspace.folderUri)`;
   otherwise the path's basename is used. The relative path is wrapped in
   inline-code backticks so any underscores or asterisks in path segments
   (e.g. `Common_Macros.hlsl`) cannot accidentally start a markdown italic
   span. Hover never reads the target file's text — the declaration line
   shown in the fenced code block is **synthesized** from `SymbolEntry`
   fields (`returnType`, `name`, `parameters`, `declaredType`, `parentType`),
   not extracted from the source. This is faster and avoids a second async
   filesystem hit per hover, at the cost of not showing leading attributes /
   comments. Acceptable for v1.
6. **No new setting.** A `unityShaderNav.hover.enabled` flag is tempting but
   buys little: VS Code already lets the user disable hover globally per
   language (`editor.hover.enabled`) and per provider (clicking the hover gear).
   Skipping a server-side flag keeps the configuration surface flat. **Revisit
   if** user feedback shows the synthesized declaration is noisy.
7. **Built-in catalog is consulted only when no visible project symbol
   matched.** Mirror the merge order used by completion in
   `handlers/completion.ts` `mergeProjectAndBuiltinSuggestions`. This prevents
   a project-defined `Sample` shadowing the built-in `Sample` from showing the
   built-in's text on hover.
8. **Origin range echoed back.** `Hover.range` is set to the cursor word range
   (`wordAt` for plain identifiers, `memberAccess.member.range` for member
   access) so VS Code underlines exactly the identifier the hover describes.
   Without this, VS Code falls back to the host language's word boundary which
   may include the dot.
9. **Hovering the declaration itself is allowed.** When the cursor lies on
   the identifier of a declaration (e.g. on `Helper` in `float4 Helper(...)
   { ... }`), `resolveDefinitionSymbols` returns the same symbol whose
   `location.range` *is* the cursor's word range. Hover renders the same
   card it would for a *use* of that symbol. This matches the behavior of
   VS Code's built-in TypeScript hover, and `definition.ts` does not special-
   case it either. Pin the behavior with a test so a future change is
   intentional.

---

### Task 1: Hover Formatter (Pure)

**Files:**
- Create: `unity-shader-nav/server/src/hover/format.ts`
- Create: `unity-shader-nav/server/src/hover/index.ts` (barrel)
- Create: `unity-shader-nav/server/tests/hover/format.test.ts`

**Step 1: Public API**

```ts
import type { MarkupContent } from 'vscode-languageserver/node';
import type { SymbolEntry } from '@unity-shader-nav/shared';
import type { BuiltinEntry } from '../suggestions/builtins';

export interface ProjectHoverInput {
  source: 'project';
  symbol: SymbolEntry;
  /** Optional workspace root URI for relativizing the source-location footer. */
  workspaceRootUri?: string;
}

export interface BuiltinHoverInput {
  source: 'builtin';
  entry: BuiltinEntry;
}

export type HoverInput = ProjectHoverInput | BuiltinHoverInput;

/** Format a single candidate into a markdown MarkupContent block (no separator). */
export function formatHoverCandidate(input: HoverInput): MarkupContent;

/** Format up to N candidates as a single MarkupContent, joining with `---`. */
export function formatHoverCandidates(inputs: HoverInput[], maxCandidates?: number): MarkupContent;
```

`formatHoverCandidate` rules per `SymbolEntry.kind`:

- `function` (`FunctionSymbolEntry`): fenced HLSL block
  ` ```hlsl\n${returnType} ${name}(${params})\n``` ` where `params` joins
  `${type} ${name}` with `, ` (matches `signatureLabelOf` exactly). Cast the
  entry to `FunctionSymbolEntry` only when `kind === 'function'`.
- `struct`: ` ```hlsl\nstruct ${name}\n``` `.
- `structMember`: ` ```hlsl\n${declaredType ?? 'unknown'} ${name};\n``` ` then a
  trailing line `_member of_ \`${parentType}\`` when `parentType` is set.
- `variable`: ` ```hlsl\n${declaredType ?? 'unknown'} ${name};\n``` `.
- `parameter`: ` ```hlsl\n${declaredType ?? 'unknown'} ${name}\n``` ` (no
  trailing semicolon — parameters are not declarations).
- `localVariable`: same as `variable`.
- `macro`: ` ```hlsl\n#define ${name}\n``` ` (v1 does not synthesize macro
  bodies; ADR-0003's macro patterns are matched as names, not text — adding
  body extraction is a follow-up).
- `cbuffer`: ` ```hlsl\ncbuffer ${name}\n``` `.

Append a single-line footer ``\n\n_in_ `${relativePathOrBasename}`:${line+1}``
where `line` is `symbol.location.range.start.line` (0-based, so `+1` for human
reading). Conversion rules:

1. `absPath = fileURLToPath(symbol.location.uri)` (from `node:url`) — handles
   percent-decoding *and* the Windows drive-letter leading slash. Do **not**
   `decodeURIComponent` the URL path manually.
2. If `workspaceRootUri` is provided: `rootPath = fileURLToPath(workspaceRootUri)`;
   if `absPath` starts with `rootPath + path.sep`, strip the prefix and the
   separator. Use forward slashes in the output (`path.replaceAll(path.sep,
   '/')`) for display consistency across OSes.
3. Otherwise emit `path.basename(absPath)`.

Wrap the resulting path in backtick inline-code so markdown italic/bold
markers inside path segments (rare `_`, `*`) cannot break formatting; the
trailing `:${line+1}` stays outside the backticks so VS Code's
"file:line"-style detection can still pick it up if it wants to.

`formatHoverCandidate` for `BuiltinEntry`:

- If `kind === 'function'` and the entry has `parameters`: fenced HLSL block
  with `${returnType ?? 'void'} ${name}(${params})` (same param formatting as
  the project case).
- Otherwise: fenced block with `entry.detail ?? entry.name`.
- Append `entry.documentation` as a plain paragraph after the fenced block (no
  fenced wrapping — it is prose).
- Append a final line `_${categoryLabel(entry.category)}_` so the source is
  unambiguous. `categoryLabel` is a small fixed map:
  - `'hlsl'      → 'HLSL built-in'`
  - `'unitycg'   → 'Unity built-in'`
  - `'urp'       → 'URP built-in'`
  - `'shaderlab' → 'ShaderLab built-in'`
  - `'semantic'  → 'HLSL semantic'`
  This avoids leaking the internal enum spelling (`_built-in (unitycg)_`)
  and gives `POSITION` a cleaner footer (`_HLSL semantic_`).

`formatHoverCandidates(inputs, maxCandidates = 5)`:

- If `inputs.length === 0`: return `{ kind: 'markdown', value: '' }` (caller
  treats empty value as "no hover").
- If `inputs.length === 1`: return `formatHoverCandidate(inputs[0])`.
- Otherwise: render a leading `**${shown} candidates**` line, then up to
  `maxCandidates` candidates joined by `\n\n---\n\n`, then a final
  `\n\n_… and ${extra} more candidates_` line when `inputs.length >
  maxCandidates`. `shown = min(inputs.length, maxCandidates)`.

**Step 2: Tests (Vitest, inline strings)**

Cover:

- Function: returnType/name/params rendered exactly like `signatureLabelOf`.
- Function with no parameters → `${returnType} ${name}()`.
- Struct, structMember (with and without `parentType`), variable, parameter,
  localVariable, macro, cbuffer — assert the exact fenced HLSL contents and
  the footer.
- `workspaceRootUri` strip: same-prefix → relative path; different host →
  basename only.
- URI-encoded path → footer shows decoded path via `fileURLToPath`
  (`file:///F:/Tab%20s.hlsl` → ``in `Tab s.hlsl`:N``, NOT `/F:/Tab%20s.hlsl`).
- Windows drive-letter URI → no leading `/` in the output.
- Built-in function entry → fenced signature + documentation paragraph +
  `_HLSL built-in_` line (category `'hlsl'`).
- Built-in non-function entry → fenced `detail ?? name` + documentation +
  human label line; assert one case per `BuiltinCategory` value to pin the
  `categoryLabel` map.
- `formatHoverCandidates`: 0 inputs → empty string; 1 input → identical to
  single; 2 inputs → header + `---` separator; 7 inputs with cap 5 → header
  reads `5 candidates` (the shown count), separator-joined block, then
  `_… and 2 more candidates_` line.

**Step 3: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run tests/hover/format.test.ts
```

Expected: new suite passes; no other suites disturbed.

---

### Task 2: Hover Handler

**Files:**
- Create: `unity-shader-nav/server/src/handlers/hover.ts`
- Modify: `unity-shader-nav/server/src/server.ts`
- Modify: `unity-shader-nav/server/src/connection.ts`
- Create: `unity-shader-nav/server/tests/handlers/hover.test.ts`

**Step 1: Capability**

In `connection.ts` `createInitializeResult`, add `hoverProvider: true` to the
`capabilities` object next to `definitionProvider: true`. This is the only
client-protocol change needed — `vscode-languageclient` wires the rest.

**Step 2: Handler**

`registerHoverHandler(connection, documents, manager, suspender)` modeled on
`registerDefinitionHandler`:

```ts
connection.onHover(async (params: HoverParams): Promise<Hover | null> => { ... })
```

Body sketch (lifted from `definition.ts` — keep the structure aligned so the
two handlers remain easy to diff):

1. `documents.get(params.textDocument.uri)` → bail if missing.
2. `manager.workspaceForOrCreateFile(params.textDocument.uri)` → bail if no
   workspace (matches `definition.ts`).
3. Read `fullText`. **Do not** parse `#include` for hover — there is no
   "hover an include path" UX in this issue, unlike definition.
4. Get or reindex the file index via `workspace.store.get(uri)` /
   `workspace.reindex(uri, fullText)`; bail on miss.
5. `isGenericDefinitionContext(fullText, params.position, doc.languageId,
   uri)` → return `null` if rejected (mirror definition's behavior; this is
   what prevents hover in comments/strings).
6. `visibleUriKeys = await collectVisibleUriKeys(...)`.
7. `memberAccess = memberAccessAt(fullText, params.position)`. If
   `memberAccess?.receiver`:
   - `symbols = resolveMemberSymbols(idx, workspace.global, receiver.text,
     member.text, position, { visibleUriKeys })`.
   - If `symbols.length > 0`: format with `formatHoverCandidates(symbols.map(s
     => ({ source: 'project', symbol: s, workspaceRootUri:
     workspace.folderUri })))` and return `{ contents, range:
     memberAccess.member.range }`.
   - If `symbols.length === 0`: **fall through to plain word resolution**
     (steps 8+). This matches `handlers/definition.ts:130-150`, which logs
     `member.result { links: 0 }` and proceeds to `wordAt` /
     `resolveDefinition` unconditionally. Hover must keep parity (acceptance
     criterion 3) — diverging here would mean hover misses cases that
     "go-to-definition" still resolves on the same cursor. The plain-word
     resolver may or may not return something useful for a member-position
     cursor, but the index, not the handler, decides.
8. `word = wordAt(fullText, params.position)`; return `null` if no word.
9. `projectSymbols = resolveDefinitionSymbols(idx, word.text, position,
   workspace.global, { visibleUriKeys })`.
10. If `projectSymbols.length > 0`: format with
    `formatHoverCandidates(projectSymbols.map(s => ({ source: 'project',
    symbol: s, workspaceRootUri: workspace.folderUri })))` and return with
    `range: word.range`.
11. Otherwise consult the built-in catalog: `BUILTIN_ENTRIES.filter(entry =>
    entry.name === word.text)`. If a match exists, return
    `formatHoverCandidates(matches.map(entry => ({ source: 'builtin',
    entry })))` with `range: word.range`. The catalog is unique-on-name today
    (verified in `suggestions/builtins/catalog.ts`) but the formatter handles
    arrays so future duplicates render stacked rather than silently picking
    one — see Non-Goals.
12. Otherwise return `null`.

Wrap the body in `suspender ? suspender.run(...) : ...` exactly like
`definition.ts`.

**Step 3: Register in `server.ts`**

Add `import { registerHoverHandler } from './handlers/hover';` and call
`registerHoverHandler(connection, documents, manager, suspender)` right after
`registerDefinitionHandler(...)`. The other handlers all accept the same
positional shape `(connection, documents, manager, suspender?)`; hover follows
the same shape — no `getSettings` callback because v1 has no setting.

**Step 4: Handler tests**

Follow `tests/handlers/definition.test.ts`'s fake-Connection pattern. The fake
must capture `connection.onHover(fn)`; everything else (`onInitialize`,
`onInitialized`, `console.log/warn/error`, `workspace.getConfiguration`) is
stubbed exactly the same way as in the definition test. Pass a real
`RequestSuspender` (so the suspender path is exercised) and a fake
`WorkspaceManager` matching the definition test's surface.

Required cases (inline fixtures, prefer single-file unless the case is
inherently cross-file):

- **Function hover (same file):** declare `float Foo(float a) { ... }` then
  call `Foo(1)`; hover the call → markdown body matches `formatHoverCandidate`
  exactly, `range` equals the word range of `Foo` at the call site.
- **Function hover (cross-file via include):** receiver file `Lib.hlsl`
  declares `float Bar(float)`, consumer `Frag.hlsl` `#include "Lib.hlsl"`;
  hover `Bar(...)` in `Frag.hlsl` → returns the cross-file declaration.
- **Visibility filtering:** the same function name in an *unincluded* sibling
  file is omitted from the candidate list. Asserts hover honors
  `collectVisibleUriKeys` (acceptance criterion 3).
- **Struct + member hover:** struct `S { float x; }`, code `s.x` → hover `x`
  returns the member entry with `_member of_ \`S\`` footer; hover `s` returns
  the local-variable / parameter declaration.
- **Local variable / parameter hover:** parameter and local-variable hovers
  return the scope-narrowed entry only when the cursor is inside `scopeRange`;
  outside scope, the outer global of the same name (if any) wins, otherwise
  `null`.
- **Macro hover:** `#define MY_THING 1` then a reference `MY_THING` → fenced
  `#define MY_THING` plus the source footer.
- **Ambiguous (multi-candidate):** two same-named global functions visible
  from the cursor → hover renders the stacked candidates with `2 candidates`
  header and a `---` separator.
- **Built-in fallback:** unknown project name that exists in `BUILTIN_ENTRIES`
  (e.g. `lerp` or any catalog entry) → built-in hover with documentation +
  `_built-in (...)_` footer. Use whatever name actually exists in the
  catalog — the test should import `BUILTIN_ENTRIES` and pick a `function`
  entry programmatically rather than hardcoding a name that could be renamed.
- **Comment guard:** cursor in a `//` line comment → `null`. Cursor in a
  string → `null`. Driven by `isGenericDefinitionContext` already, but assert
  explicitly so a regression in the guard does not silently surface hovers in
  comments.
- **ShaderLab declarative section guard:** in a `.shader` file, cursor on an
  identifier inside `Properties { ... }` or a `Tags { ... }` block (outside
  any `HLSLPROGRAM`/`CGPROGRAM` block) → `null`. Pins the second branch of
  `isGenericDefinitionContext` (the `!isInsideShaderLabHlslBlock` check).
- **Hovering the declaration itself:** cursor on the function name in
  `float4 Foo() { ... }` → hover returns the function card (design
  decision 9). Pins the behavior; any future "suppress on self-hover"
  change will need to update this test deliberately.
- **Member resolution empty → falls through:** receiver type cannot be
  inferred (e.g. `unknown.x`); hover at `x` exercises the fall-through to
  `wordAt(...)` + `resolveDefinitionSymbols('x', ...)`. Whatever the index
  returns for the bare name `x` is what hover should return — assert parity
  with calling `resolveDefinitionSymbols` directly on the same fixture.
- **No-match:** unknown identifier with no project or built-in match →
  `null`.

**Step 5: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run tests/handlers/hover.test.ts
npx vitest run
```

Expected: hover suite passes; whole server suite stays green.

---

### Task 3: Client Integration Test

**Files:**
- Create: `unity-shader-nav/tests/integration/client/hover.test.ts` (matching
  the existing layout — there is no `tests/electron/` directory; the
  integration suites live in `tests/integration/client/`, driven by Mocha and
  bootstrapped by `unity-shader-nav/tests/runTest.ts`).
- Use the existing `withWorkspaceFolder` helper at
  `tests/integration/client/helpers/workspace.ts` for fixture setup, the same
  way `definition.test.ts` and `completion.test.ts` do. Reuse one of the
  existing fixture folders under `tests/integration/client/fixtures/` if a
  suitable one already contains a function declaration + call site;
  otherwise add a minimal new fixture.

**Step 1: Smoke test**

Single Mocha test (`suite/test` style, mirroring `definition.test.ts`) that:

1. Opens a fixture `.hlsl` (or `.shader`) document with a known function and
   call site via `withWorkspaceFolder`.
2. Polls
   `vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider',
   uri, position)` at the call-site identifier — use the same retry loop
   pattern as `definition.test.ts`'s `waitForDefinitions` so the test does
   not race the indexer on cold open.
3. Asserts the returned array is non-empty and the first hover's
   `contents[0]` (or `.value` on `MarkdownString`) contains the function name
   and the fenced ` ```hlsl ` marker. Do **not** snapshot the entire payload —
   the formatter has its own unit tests; this test only proves the request
   flows through the client+server wiring.

**Step 2: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
npm test
```

Expected: server Vitest + electron Mocha suites both green.

---

### Task 4: Docs

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/technical-spec.md` (if it enumerates LSP capabilities)
- Modify: `docs/usage.md` (one user-facing line)
- Modify: `CHANGELOG.md`
- Modify: `docs/roadmap.md` (mark hover as delivered / first-pass)
- Modify: `README.md` / `README.zh-CN.md` / `README.ja.md` (one feature line
  each)
- Optional: `docs/adr/0006-conservative-hover-information.md` if reviewers
  conclude the design has long-term architectural weight (the multi-candidate
  stacking choice and the "synthesize declaration from index, not source file"
  choice are the only ADR-worthy decisions). Default to **no ADR** for v1;
  add one only if a reviewer flags it.

**Step 1: architecture.md**

Update the `handlers` bullet to mention hover, mirroring how inactive-region
dimming was added in the issue-22 plan. Add to the bullet list:
`hover, ...`.

**Step 2: usage.md / README**

One short line per surface, e.g.:
"Hover (mouse pause / `Ctrl+K Ctrl+I`) on a project symbol to see its
declaration and source location; ambiguous symbols are listed without
guessing."

**Step 3: CHANGELOG**

Unreleased entry:
`feat(issue-18): hover information for indexed shader symbols (functions,
structs, members, variables, parameters, macros, selected built-ins).`

**Step 4: roadmap.md**

Move the hover line from `Planned` to `Delivered` (or whatever section names
the file uses; check before editing).

**Step 5: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
npm run build
npm test
```

Expected: full build + tests stay green.

**Step 6: Manual verify (Extension Development Host)**

1. `npm run watch`; wait for `[watch-runtime] build ok`; press F5.
2. Open a project with `.hlsl` / `.shader` files.
3. Hover a project function call → fenced HLSL signature + source-location
   footer.
4. Hover a struct field after `s.x` → member declaration + `_member of_ S`.
5. Hover a built-in name (e.g. `lerp`) → built-in signature + documentation +
   `_built-in (hlsl)_`.
6. Hover an identifier inside `// ...` → no hover.
7. Hover an identifier whose definition exists in *two* visible includes →
   stacked candidates with `2 candidates` header.

Record the manual-verify result back on issue #18 (per `CLAUDE.md`).

**Step 7: Commit**

```powershell
cd F:\Project\UnityShaderNav
git add docs/architecture.md docs/usage.md docs/roadmap.md CHANGELOG.md README.md README.zh-CN.md README.ja.md
git commit -m "docs(issue-18): document hover information"
```

Ensure no build output under `client/out`, `server/out`, `shared/out`, or
`tests/out` is staged.

---

## Acceptance Criteria Traceability

| Issue acceptance criterion | Covered by |
| --- | --- |
| Hover on an indexed project function shows signature + source location | Task 1 (function formatter), Task 2 (handler), Task 2 test "Function hover (same file)" |
| Hover on structs/members/variables/parameters/macros shows concise summary | Task 1 (per-kind formatter rules), Task 2 tests for each kind |
| Respects local scope + include-visibility (same as definition/completion) | Task 2 uses `resolveDefinitionSymbols` / `resolveMemberSymbols` + `collectVisibleUriKeys` (design decision 1); Task 2 tests "Visibility filtering" and "Local variable / parameter hover" |
| Ambiguous candidates presented conservatively, no fake authority | Design decision 3 (stacked rendering with header + separator); Task 2 test "Ambiguous (multi-candidate)" |
| Server unit tests + at least one VS Code integration test | Task 1 + Task 2 (Vitest); Task 3 (electron Mocha smoke) |

## Non-Goals

- **No preprocessor evaluation.** Hover never picks a winner between
  `#ifdef`-gated candidates (design decision 2; ADR-0005 holds).
- **No source-text extraction.** Declarations are synthesized from
  `SymbolEntry` fields; we do not open the target file to copy its raw
  declaration line. Trailing attributes / preceding doc comments are out of
  scope for v1 (design decision 5).
- **No new setting.** The user can disable hover globally via VS Code's
  existing per-language hover toggles (design decision 6).
- **No hover-for-include-paths.** Definition supports this; hover does not.
  Hovering `#include "Lib.hlsl"` is `null` in v1.
- **No macro body extraction.** A macro hover renders only `#define NAME`;
  the value/text after the name is not parsed in v1.
- **No built-in entries that do not exist in the catalog.** If a name is a
  real HLSL intrinsic but missing from `BUILTIN_ENTRIES`, hover returns
  `null` for it (treated identically to "unknown identifier").
- **No deduping of built-in catalog duplicates.** `BUILTIN_ENTRIES` is
  unique-on-name today (verified in `suggestions/builtins/catalog.ts`), but
  the loader does not enforce it. If duplicates ever appear, hover renders
  *all* matches stacked rather than picking one — same conservatism as
  multi-candidate project symbols.
- **No hover in ShaderLab declarative sections.** Cursor inside `Properties
  { ... }`, `Tags { ... }`, or any `.shader` region outside `HLSLPROGRAM` /
  `CGPROGRAM` / `HLSLINCLUDE` / `CGINCLUDE` returns `null` because
  `isGenericDefinitionContext` rejects it. ShaderLab keyword hover is a
  separate concern and is not in scope for v1.

---

## Plan Authoring Commit

When writing or revising this plan file before implementation, commit only:

```powershell
cd F:\Project\UnityShaderNav
git add docs/plans/2026-05-28-issue-18-hover-information.md
git commit -m "docs(issue-18): plan hover information"
```

The per-task `feat(issue-18)` / `test(issue-18)` / `docs(issue-18): document
...` commits are for the future execution of this plan, not for this
plan-writing change.

---

## Review Notes (independent reviewer, 2026-05-28)

> **Resolution (2026-05-28, all notes 评估后采纳):** 10 条经核对全部成立,已折回
> 本计划:
> - **P1 `workspace.rootUri` 不存在** → 改用 `workspace.folderUri`(见
>   `workspace/workspace.ts:34`);设计决策 5 与 Task 2 Step 7/10 同步更新。
> - **P1 member-empty 应 fall through** → Task 2 Step 7 改为"member 解析为空
>   时落到 `wordAt` + `resolveDefinitionSymbols`",与
>   `definition.ts:130-150` 行为对齐(验收准则 3 要求一致的可见性模型)。
> - **P2 `fileURLToPath` 替代 `decodeURIComponent`** → 设计决策 5 与 Task 1
>   Step 1 改用 `fileURLToPath(symbol.location.uri)`,正确处理 Windows 盘符
>   leading slash,沿用 `workspace/workspaceManager.ts:71` 的现有约定。
> - **P2 集成测试路径** → Task 3 改到 `tests/integration/client/hover.test.ts`,
>   复用 `withWorkspaceFolder` helper 和 `definition.test.ts` 的 `waitFor*`
>   retry 模式。
> - **P2 `isGenericDefinitionContext` 也拦截 ShaderLab 声明段** → Context
>   bullet 写明两个分支,Task 2 Step 4 新增"hover 进 Properties/Tags →
>   null"测试,Non-Goals 也补一条。
> - **P2 hover 声明位本身的边界** → 新增设计决策 9 显式接受该行为,Task 2
>   Step 4 加 "Hovering the declaration itself" 回归测试。
> - **P3 cap=5 的依据** → 设计决策 3 改写为"hover MarkupContent payload
>   size",不再绑 ADR-0001;后续调整建议另起 follow-up ADR。
> - **P3 markdown 注入风险** → 源位 footer 改用 inline-code backtick 包路径
>   (设计决策 5、Task 1 Step 1),`_member of_` 行同样用 backtick 包
>   `parentType`,避免少见路径(`Foo _ Bar.hlsl` 等)被 markdown 误解析。
> - **P3 built-in category 文案** → Task 1 Step 1 新增 `categoryLabel` 映射
>   表(`unitycg → "Unity built-in"` 等),避免直接渲染内部 enum 名。
> - **P3 BUILTIN_ENTRIES 唯一性** → Non-Goals 新增"重复 catalog 条目不去重,
>   直接 stacked 渲染"。
>
> 原始 review 留档:
> `docs/plans/2026-05-28-issue-18-hover-information-review.md`。
