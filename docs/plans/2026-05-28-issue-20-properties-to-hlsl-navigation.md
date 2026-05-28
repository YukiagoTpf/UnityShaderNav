# Properties ↔ HLSL Declaration Navigation Implementation Plan

> **For Claude:** Implement this plan task-by-task. Execute one Task, then
> commit one `feat(issue-20)` / `test(issue-20)` commit before starting the
> next, per `CLAUDE.md` 执行纪律. The plan-authoring commits (`docs(issue-20)`)
> are separate and described at the end.

**Goal:** Wire `textDocument/definition` so a user can F12 between a
ShaderLab `Properties` entry and the matching HLSL/CG declaration in either
direction. The bridge is conservative and name-based: it surfaces every visible
candidate without picking a winner, mirrors the visibility model used by
existing HLSL F12 (ADR-0001), and never claims authority when more than one
candidate survives filtering.

**Architecture:** Two new pure modules
(`parser/shaderlab/propertiesScanner.ts`, `index/propertyBridge.ts`) feed
a thin patch into `handlers/definition.ts`. The flow is:

1. `propertiesScanner.scanProperties(text)` returns
   `ShaderLabPropertyEntry[]` — every property declaration in `Properties { ... }`
   with name range, full declaration range, and a small descriptor (`type`,
   `displayName`, `defaultLiteral`). This is the source of truth for *both*
   directions. Output goes into `FileIndex.properties` (new optional field on
   `FileIndex` in `shared/src/symbols.ts`).
2. `fileIndexer.indexFile` calls the scanner for `.shader` files, attaches
   the result to the returned `FileIndex`, and pushes each property name as a
   lightweight `ReferenceEntry` (`context: 'identifier'`) so existing
   `workspace.globalRefs` reverse lookups keep working without a new index
   shape.
3. `index/propertyBridge.ts` exposes two pure functions used only by the
   definition handler:
   - `propertyAt(idx, position)` → returns the property whose name range
     covers the cursor, or `null`.
   - `findPropertyCandidatesForName(name, store, visibleUriKeys)` → scans
     visible `.shader` indexes and returns every property entry whose name
     equals `name`. Used for the reverse (HLSL → Properties) direction.
4. `handlers/definition.ts` gets a new branch at the very top of the
   word-resolution path:
   - **Forward:** if `propertyAt(idx, pos)` matched, resolve HLSL
     declarations for that property name via the existing
     `resolveDefinitionSymbols(idx, name, pos, workspace.global,
     resolutionOptions)` (which already does visibility + ambiguity), then
     return them as `LocationLink[]` with the property-name range as
     `originSelectionRange`.
   - **Reverse:** after `resolveDefinition` has produced HLSL candidates for
     a plain word, also call `findPropertyCandidatesForName(word.text,
     workspace.store, visibleUriKeys)` and append any property entries as
     extra `LocationLink`s. This is the *append* path — HLSL definitions still
     come first, Properties join the candidate list.
5. `parser/lexical/context.ts` `isGenericDefinitionContext` is extended with
   a single targeted exception: if the cursor is on a property-name token
   inside a `Properties { ... }` block, the function returns `true` even
   though the cursor is outside any HLSL block. This is the *only* place the
   ShaderLab declarative gate is relaxed.

**Tech Stack:** TypeScript, npm workspaces (`shared` / `server` / `client`),
`vscode-languageserver` (server), Vitest (server unit tests), Mocha +
`@vscode/test-electron` (client/integration). Existing modules reused:
`parser/shaderlab/blockScanner.scanBlocks`,
`parser/shaderlab/sanitize.sanitizeLine`, `parser/hlsl/fileIndexer.indexFile`,
`index/symbolResolver.resolveDefinitionSymbols`,
`index/visibility.collectVisibleUriKeys`, `index/wordAt.wordAt`.

---

## Context

Current state (verified against the tree, 2026-05-28):

- `unity-shader-nav/server/src/parser/hlsl/fileIndexer.ts:114-134` is the
  current `.shader` indexer. It iterates `scanBlocks(text).blocks`, parses
  every HLSL/CG block with tree-sitter, and merges per-block symbols and
  references into a single `FileIndex`. Critically, **the Properties block
  contributes nothing to `merged.symbols` or `merged.references`** — it is
  not parsed by anything that participates in F12 today. `merged.structure =
  scanStructure(text)` only records Shader/SubShader/Pass headers.
- `unity-shader-nav/server/src/parser/shaderlab/tokenScanner.ts:217-229`
  already implements a working detection of `^\s*([A-Za-z_]\w*)\s*\(` inside
  the Properties block and emits a `'property'` semantic token. This is the
  closest existing reference for property-name tokenisation; the new scanner
  must agree with it character-for-character (same regex, same masking of
  strings/comments), so that semantic highlighting and F12 origins line up
  pixel-perfect. The same file (lines 320-338) shows the correct way to
  track `propertiesDepth` across nested `{ }`.
- `unity-shader-nav/server/src/parser/shaderlab/blockScanner.ts:75-126` gives
  HLSL block content ranges (`contentStartLine` / `contentEndLine`). These
  are necessary to *exclude* HLSL block lines from the Properties scan
  (Properties cannot legally contain an HLSL block, but a malformed file
  may; the scanner must not crash on it).
- `unity-shader-nav/server/src/parser/shaderlab/sanitize.ts`'s `sanitizeLine`
  is the line-level comment/string masker used by `structureScanner`. The
  new property scanner should reuse it (or `tokenScanner`'s `maskComments` +
  `maskStrings`) rather than re-implementing lexical masking — the bugs in a
  hand-rolled masker are uniformly comment-inside-string and
  string-inside-comment.
- `unity-shader-nav/server/src/parser/lexical/context.ts:81` is the gate the
  definition / hover handlers consult. It returns `false` for `.shader`
  cursors that are not inside any HLSL block, which is what currently
  prevents Properties F12 from working. The fix is local: add a
  `isShaderLabPropertyNameContext(text, pos, languageId, uri)` predicate that
  returns `true` only when the cursor's `(line, character)` falls inside a
  property-name token *and* inside a Properties block — and OR it into the
  acceptance condition. The lexical-comment/string guard still applies
  (`lexicalContextAt(text, pos) === 'code'`); the new branch only relaxes
  the HLSL-block gate, not the comment/string gate.
- `unity-shader-nav/server/src/handlers/definition.ts` is the patch point.
  Today it goes: include-jump → reindex-if-needed → context gate → member
  → word → resolveDefinition. The new property-name branch fits *between*
  the context gate and the member-access branch (a property-name token is
  never a member access), so the failure mode is "no candidates → fall
  through to the existing path", not "silent return null".
- `unity-shader-nav/shared/src/symbols.ts:55-62` defines `FileIndex` with
  `symbols`, `references`, optional `typeInferences`, optional `structure`.
  Adding an optional `properties?: ShaderLabPropertyEntry[]` keeps wire
  compatibility (older consumers ignore it).
- Visibility: `collectVisibleUriKeys(store, includeCtx, uri)` is asymmetric
  — it follows `#include` references *out from* `uri`. For the
  HLSL → Properties direction the relevant visibility relation is the
  inverse (which `.shader` files include the HLSL file the cursor is in).
  Two pragmatic options exist; see design decision 3 for which one this plan
  picks and why.
- `workspace.global: GlobalSymbolIndex` (`index/globalIndex.ts`) keys by
  symbol name → `SymbolEntry[]`. It does not see property entries today.
  This plan keeps it that way and adds a small per-store scan for the
  reverse lookup (`findPropertyCandidatesForName`) rather than pushing
  properties into the global symbol index, because property names live in
  a different namespace from HLSL identifiers (a project that legally
  declares both a property `_MainTex` and a function named `_MainTex`
  is permissible, however unusual; mixing them in `byName` would create
  spurious member-access hits in `chainLookup`).
- Test patterns:
  - **Server unit:** `unity-shader-nav/server/tests/handlers/definition.test.ts`
    is the closest precedent for the handler patch — it fakes `Connection`,
    `WorkspaceManager`, and drives the captured `onDefinition` handler.
    The new property bridge tests live next to it as
    `definition-properties.test.ts`.
  - **Scanner unit:** `unity-shader-nav/server/tests/parser/shaderlab/`
    contains `blockScanner.test.ts` and `tokenScanner.test.ts`. The new
    `propertiesScanner.test.ts` follows the inline-string Vitest pattern.
  - **Integration:** `unity-shader-nav/tests/integration/client/definition.test.ts`
    drives `vscode.executeDefinitionProvider`. The new
    `properties-to-hlsl.test.ts` uses the same `withWorkspaceFolder`
    helper and the same `waitForDefinitions(uri, pos, predicate)`
    retry pattern.
- Issue 20 acceptance criteria mapping:
  - Forward direction → Task 4 (handler patch) + Task 5 (integration).
  - Reverse direction → Task 4 (handler patch) + Task 5 (integration).
  - Common property shapes → Task 2 (`PROPERTY_TYPES` whitelist: 2D, 3D,
    Cube, CubeArray, Color, Vector, Float, Range, Int) — same set as
    `tokenScanner.ts:45-54` plus `CubeArray` (the tokeniser is missing it;
    see Out of Scope for why we don't fix tokeniser in this PR).
  - Ambiguous same-name → returned as multi-candidate `LocationLink[]`
    (ADR-0001 pattern); Task 4 test "Ambiguous duplicate property name".
  - Tests cover `.shader` with embedded HLSL and include-visible
    declarations → Task 5 fixtures `properties-inline-hlsl.shader` and
    `properties-include/`.

### Design decisions (rationale; reviewers may sharpen)

1. **Properties become a separate `FileIndex` field, not entries in
   `symbols`.** Pushing property entries into `FileIndex.symbols` would make
   them visible to `resolveDefinitionSymbols`, `chainLookup`, and every
   other code path that filters `symbols.filter(s => s.name === name)`.
   That conflates two namespaces. Keeping a dedicated `properties` field
   means: (a) `resolveDefinitionSymbols` semantics stay unchanged and
   (b) the bridge handler explicitly opts in by calling
   `findPropertyCandidatesForName`. Cost: one extra type in `shared`. Worth
   it.
2. **Bridge is in the definition handler, not in `symbolResolver`.** The
   resolver is generic and shared with `resolveReferenceTargets`. Adding a
   "if name matches a property in any visible shader" branch to the
   resolver would leak the bridge into Find References too — not in scope
   for issue 20 and would change reference-counting semantics. The handler
   is the right layer.
3. **Reverse visibility uses "any indexed .shader in the workspace whose
   HLSL/CG blocks reference the same symbol's name", not "files that
   include this HLSL file".** Computing the inverse-include graph requires
   either a global include map (none exists) or scanning every `.shader`
   per request (O(workspace) per F12). Both are heavier than the
   acceptance criteria need. The conservative name-based rule is:
   `findPropertyCandidatesForName(name)` walks `store.uris()`, picks
   entries whose URI ends with `.shader` and whose `FileIndex.properties`
   contains a name match. This is O(shaders) per F12, no async, no
   include resolution. It may surface a property from an unrelated shader
   that happens to declare the same name — that is acceptable because
   acceptance criterion 4 explicitly says ambiguous same-name candidates
   return multiple locations instead of guessing. The user picks via the
   VS Code Peek UI (ADR-0001). **Revisit if** real-world feedback shows
   noise; the next step would be filtering to shaders whose HLSL blocks
   contain a declaration of the same symbol, which is a one-pass index
   lookup on the shader's own `FileIndex.symbols`.
4. **Property-name *cursor* gate is a positive predicate, not a relaxed
   global gate.** `isGenericDefinitionContext` currently rejects every
   `.shader` cursor that is outside an HLSL block. The temptation is to
   relax it ("return true if inside `Properties { ... }`"). Don't:
   that would make `Tags { ... }` strings, `Pass { Name "X" }`, and every
   ShaderLab keyword eligible for F12, producing many empty results and
   confusing the user. The new branch returns `true` *only* when the
   cursor lies on a token that the property scanner recognises as a
   property name — i.e., the scanner is the authority and the lexical
   gate consults it. Implementation: in
   `isGenericDefinitionContext`, before the existing HLSL-block check,
   call `propertyNameAt(text, pos)` (a new pure helper that reuses the
   scanner) and return `true` if it matched. The comment/string guard
   still runs for both branches.
5. **No new setting.** The bridge is always-on. Property-name F12 has no
   surprising side effects: when no HLSL declaration matches the cursor
   property, the handler returns `null` and VS Code falls back to its
   default "no definition found" toast — identical to today's behavior
   for any unmatched word. A `unityShaderNav.propertyBridge.enabled`
   flag would clutter the settings surface for zero observable benefit.
   **Revisit if** the reverse direction proves noisy on real projects.
6. **No new ADR.** This change is one F12 source/sink pair and does not
   alter the symbol-resolution invariants (multi-candidate behavior,
   visibility, preprocessor-naive — all unchanged). ADR-0001 already
   covers the multi-candidate UX. If the inverse-visibility heuristic in
   design decision 3 changes later, *that* gets its own ADR — not this
   patch.
7. **`displayName` and `defaultLiteral` are extracted but not used.**
   The scanner captures them so a follow-up hover/outline feature can
   render `_MainTex ("Base Map", 2D) = "white"` style summaries without
   re-parsing. They cost one extra regex group each; storing them now
   avoids a second touch on the same scanner later.
8. **Property scanner is a pure function over text, not a tree-sitter
   pass.** Properties syntax is line-oriented, decorator-prefixed, and
   nests no further than one level. A regex-based scanner is right-sized
   (matches the existing `tokenScanner.ts` and `structureScanner.ts`
   approach) and avoids pulling tree-sitter into a non-HLSL context. Cost:
   the scanner cannot represent malformed/half-typed properties as a tree
   for diagnostics. Acceptable — diagnostics are out of scope for
   issue 20.
9. **`Texture2DArray` / `CubeArray` are recognised; `Any` / `PowerSlider`
   decorators are ignored.** The whitelist is `2D`, `3D`, `Cube`,
   `CubeArray`, `Color`, `Vector`, `Float`, `Range`, `Int`. Decorators
   (`[NoScaleOffset]`, `[HDR]`, `[Toggle]`) are recognised by
   `tokenScanner.ts` but contribute nothing to the bridge — they live
   *before* the property name and do not change its identity. The
   scanner skips leading `\[...\]\s*` runs the same way `tokenScanner.ts`
   does (line 218).
10. **`MaterialPropertyBlock`-style scripted overrides are out of scope.**
    The bridge is purely about names declared in `Properties { ... }`
    inside the same `.shader` (forward) or any indexed `.shader` (reverse).
    Properties only set via C# `material.SetFloat("_X", v)` produce no
    `.shader` entry and therefore no candidate. Documented in Out of
    Scope.

---

## Task 1: Add `ShaderLabPropertyEntry` type to shared

**Files:**
- Edit: `unity-shader-nav/shared/src/symbols.ts`
- Edit: `unity-shader-nav/shared/src/index.ts` (if it re-exports — verify;
  otherwise no-op)

**Step 1: Type addition**

Append to `symbols.ts`:

```ts
export type ShaderLabPropertyType =
  | '2D' | '3D' | 'Cube' | 'CubeArray'
  | 'Color' | 'Vector' | 'Float' | 'Range' | 'Int';

export interface ShaderLabPropertyEntry {
  /** Identifier as written, e.g. "_MainTex". Case-sensitive. */
  name: string;
  /** Range of the name token only (used as F12 origin selection range). */
  nameRange: Range;
  /** Range covering the full declaration line (name through default literal). */
  declarationRange: Range;
  /** Whitelisted type; null for unrecognised types (still indexed by name). */
  type: ShaderLabPropertyType | null;
  /** Display name string between the outer parens, with quotes stripped. */
  displayName?: string;
  /** Raw default-value text after `=` (verbatim, no parsing). Optional. */
  defaultLiteral?: string;
}
```

Update `FileIndex` to add the optional field:

```ts
export interface FileIndex {
  uri: string;
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
  typeInferences?: TypeInferenceEntry[];
  /** Only populated for .shader files. */
  structure?: StructureResult;
  /** Only populated for .shader files. */
  properties?: ShaderLabPropertyEntry[];
}
```

**Step 2: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
npm run build
```

The build must succeed with zero TypeScript errors. No new tests in this task
(types only).

**Commit:** `feat(issue-20): add ShaderLabPropertyEntry type to shared`

---

## Task 2: Properties scanner

**Files:**
- Create: `unity-shader-nav/server/src/parser/shaderlab/propertiesScanner.ts`
- Create: `unity-shader-nav/server/tests/parser/shaderlab/propertiesScanner.test.ts`

**Step 1: Public API**

```ts
import type { ShaderLabPropertyEntry } from '@unity-shader-nav/shared';

/**
 * Scan all Properties blocks in a .shader source and return one entry per
 * property declaration. Comment- and string-aware; HLSL/CG block ranges are
 * skipped. Never throws.
 */
export function scanProperties(text: string): ShaderLabPropertyEntry[];

/**
 * Return the property entry whose name token covers (line, character), or
 * null. Used by the lexical context gate to authorise F12 on a property
 * name without authorising every position in the Properties block.
 *
 * Implementation note: if called frequently from the same text, prefer
 * passing a memoised array to a caller-side `findPropertyAt(entries, pos)`
 * over re-scanning. The handler does this — it calls scanProperties once,
 * caches via the file index, and uses the cached entries for the cursor
 * predicate.
 */
export function findPropertyAt(
  entries: readonly ShaderLabPropertyEntry[],
  position: Position,
): ShaderLabPropertyEntry | null;
```

**Step 2: Implementation outline**

```ts
// pseudocode
const PROPERTY_TYPES = new Set(['2D','3D','Cube','CubeArray',
  'Color','Vector','Float','Range','Int']);

// Match: optional decorators, name, "(", "Display", ",", Type, optional args, ")"
// Capture groups: name, displayName (quote-stripped), type, args
const PROPERTY_LINE_RE =
  /^\s*((?:\[[^\]]*\]\s*)*)([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*,\s*([A-Za-z0-9_]+)(?:\s*\([^)]*\))?\s*\)\s*(?:=\s*(.+?))?\s*(?:\/\/.*)?$/;
```

Scan loop:
1. Split text into lines once.
2. Maintain `inBlockComment` across lines (reuse the same masker as
   `tokenScanner.maskComments`; do not re-roll it).
3. Compute `blocks = scanBlocks(text).blocks`; for any line `i` with
   `blocks.some(b => b.contentStartLine <= i && i <= b.contentEndLine)`,
   skip — those are HLSL/CG content lines.
4. Track `propertiesDepth` across `{` / `}` on lines outside HLSL blocks
   (same algorithm as `tokenScanner.ts:331-334`).
5. When `propertiesDepth > 0`, run `PROPERTY_LINE_RE` against the
   comment-masked line. On match, compute:
   - `nameRange`: based on the position of capture 2 in the original
     (unmasked) line. **Use the unmasked line's `indexOf(name)` starting
     at the end of capture 1 (decorator run length) to avoid matching
     decorator text** when a decorator happens to start with the same
     identifier characters.
   - `declarationRange`: from line start to the last non-whitespace
     character in the matched line.
   - `displayName`: capture 3 (no quote stripping needed; regex already
     excludes quotes).
   - `type`: capture 4 if it is in `PROPERTY_TYPES`, else `null`.
   - `defaultLiteral`: capture 5 (trimmed; may be undefined).

**Step 3: Tests (Vitest, inline strings)**

Cover:
- Empty file → `[]`.
- File with no Properties block → `[]`.
- Single `_MainTex ("Base Map", 2D) = "white" {}` → one entry, `type='2D'`,
  `displayName='Base Map'`, `defaultLiteral='"white" {}'`.
- Multiple properties in one block, names and ranges asserted exactly.
- Each whitelisted type (`Color`, `Vector`, `Float`, `Range(0,1)`, `Int`,
  `3D`, `Cube`, `CubeArray`).
- Decorators: `[HDR] _Color ("Tint", Color) = (1,1,1,1)` → name range
  starts after the decorator run, not at the bracket.
- Multiple decorators: `[NoScaleOffset] [HDR] _Tex ("T", 2D) = "white" {}`.
- Block / line comments inside the Properties block do not produce
  false matches.
- HLSL block embedded *between* two property lines (legal? not really —
  but the scanner must not crash and must skip block content lines).
- Malformed property (missing comma, missing `)`) → entry omitted, scanner
  does not throw.
- Same name declared twice → two entries (the bridge surfaces both).
- Properties block closed by `}` on a separate line → `propertiesDepth`
  returns to 0 and a subsequent identifier on a later line is **not**
  picked up.
- `findPropertyAt`: cursor on the name → matched entry; cursor on the
  type token, the display string, or the default literal → `null`; cursor
  on an adjacent line → `null`.

**Step 4: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run tests/parser/shaderlab/propertiesScanner.test.ts
```

Expected: all new tests pass, no other test regressions.

**Commit:** `feat(issue-20): add ShaderLab Properties scanner`

---

## Task 3: Wire scanner into `fileIndexer`

**Files:**
- Edit: `unity-shader-nav/server/src/parser/hlsl/fileIndexer.ts`
- Edit: `unity-shader-nav/server/tests/parser/hlsl/fileIndexer.test.ts` (if
  one exists; verify with `Glob`. If absent, add a focused regression test
  for `.shader` Properties indexing as `fileIndexer.shader.test.ts`.)

**Step 1: Patch `indexFile`**

In the `.shader` branch (lines 114-134 today), after the existing HLSL block
loop and `merged.structure = scanStructure(text)`, append:

```ts
const properties = scanProperties(text);
if (properties.length > 0) merged.properties = properties;
```

`scanProperties` is imported from `../shaderlab/propertiesScanner`. The
`properties` field stays `undefined` when empty so the JSON wire size for
property-free shaders is unchanged. Do **not** push property entries into
`merged.symbols` or `merged.references` (design decision 1).

**Step 2: Tests**

- `.shader` with one Properties block → returned `FileIndex.properties`
  matches the scanner's output line-for-line.
- `.shader` with **no** Properties block → `FileIndex.properties` is
  `undefined`.
- `.hlsl` / `.cginc` / `.compute` file → `FileIndex.properties` is
  `undefined` (scanner not called on non-shader extensions).

**Step 3: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run tests/parser/hlsl/
```

**Commit:** `feat(issue-20): attach Properties to .shader FileIndex`

---

## Task 4: Property bridge + definition handler

**Files:**
- Create: `unity-shader-nav/server/src/index/propertyBridge.ts`
- Edit: `unity-shader-nav/server/src/index/index.ts` (re-export bridge)
- Edit: `unity-shader-nav/server/src/parser/lexical/context.ts`
- Edit: `unity-shader-nav/server/src/handlers/definition.ts`
- Create: `unity-shader-nav/server/tests/handlers/definition-properties.test.ts`

**Step 1: `propertyBridge.ts`**

```ts
import type {
  FileIndex,
  Position,
  ShaderLabPropertyEntry,
} from '@unity-shader-nav/shared';
import type { IndexStore } from './indexStore';
import { uriKey } from './uriKey';

export function propertyAt(
  idx: FileIndex,
  position: Position,
): ShaderLabPropertyEntry | null {
  if (!idx.properties) return null;
  for (const entry of idx.properties) {
    const { start, end } = entry.nameRange;
    if (position.line !== start.line) continue;
    if (position.character < start.character) continue;
    if (position.character > end.character) continue;
    return entry;
  }
  return null;
}

export interface PropertyCandidate {
  uri: string;
  entry: ShaderLabPropertyEntry;
}

export function findPropertyCandidatesForName(
  name: string,
  store: Pick<IndexStore, 'uris' | 'get'>,
  visibleUriKeys?: ReadonlySet<string>,
): PropertyCandidate[] {
  const out: PropertyCandidate[] = [];
  for (const uri of store.uris()) {
    if (visibleUriKeys && !visibleUriKeys.has(uriKey(uri))) {
      // Skip non-visible only for the same-name match path. The reverse
      // direction (HLSL ref → Property) explicitly passes `undefined` so
      // the bridge can surface properties from any indexed shader. See
      // design decision 3.
      continue;
    }
    const idx = store.get(uri);
    if (!idx?.properties) continue;
    for (const entry of idx.properties) {
      if (entry.name === name) out.push({ uri, entry });
    }
  }
  return out;
}
```

Re-export from `server/src/index/index.ts`:

```ts
export { propertyAt, findPropertyCandidatesForName } from './propertyBridge';
export type { PropertyCandidate } from './propertyBridge';
```

**Step 2: Extend the lexical gate**

In `parser/lexical/context.ts`, add a property-name predicate. The
predicate **must not** rescan the entire file on every cursor query when
called from a hot path — but `isGenericDefinitionContext` already runs
`scanBlocks` per call today, so one additional `scanProperties` call is
the same order of magnitude. Acceptable; revisit only if perf
regresses (see Verification).

```ts
import { scanProperties, findPropertyAt } from '../shaderlab/propertiesScanner';

function isShaderLabPropertyNameAt(text: string, pos: Position): boolean {
  const entries = scanProperties(text);
  return findPropertyAt(entries, pos) !== null;
}

export function isGenericDefinitionContext(
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): boolean {
  if (isShaderLabDocument(languageId, uri) && !isInsideShaderLabHlslBlock(text, pos)) {
    // Relaxation: allow F12 specifically on property-name tokens, nowhere
    // else outside HLSL/CG blocks. Comment/string guard below still applies.
    if (!isShaderLabPropertyNameAt(text, pos)) return false;
  }

  return lexicalContextAt(text, pos) === 'code';
}
```

**Step 3: Patch `handlers/definition.ts`**

Add a new branch between the lexical-context gate (currently `~line 103`)
and the `memberAccess` branch (`~line 116`). Pseudocode:

```ts
// 1) Forward: cursor on property name → HLSL declarations
const propertyHit = propertyAt(idx, params.position);
if (propertyHit) {
  trace('property.hit', { name: propertyHit.name });
  const symbols = resolveDefinitionSymbols(
    idx,
    propertyHit.name,
    params.position,
    workspace.global,
    resolutionOptions,
  ).filter((s) => s.kind === 'variable' || s.kind === 'cbuffer');
  // Cross-shader name collisions (e.g. two shaders both declare _MainTex
  // and one happens to also have a top-level HLSL `float _MainTex;`) are
  // already conservative because resolveDefinitionSymbols uses the
  // visibility set rooted at this shader file.
  if (symbols.length === 0) {
    trace('property.forward', { links: 0 });
    return null;
  }
  return symbols.map((s) => ({
    targetUri: s.location.uri,
    targetRange: s.location.range,
    targetSelectionRange: s.location.range,
    originSelectionRange: propertyHit.nameRange,
  }));
}
```

Reverse direction patch (after the existing `resolveDefinition(...)` call
that produces `links`):

```ts
// 2) Reverse: HLSL identifier may also match a property name in any
//    indexed .shader. Append property candidates to the HLSL ones.
const propertyCandidates = findPropertyCandidatesForName(
  word.text,
  workspace.store,
  // visibility is intentionally undefined here — see design decision 3
  undefined,
);
const propertyLinks: LocationLink[] = propertyCandidates.map((cand) => ({
  targetUri: cand.uri,
  targetRange: cand.entry.declarationRange,
  targetSelectionRange: cand.entry.nameRange,
  originSelectionRange: word.range,
}));
const combined = [...links, ...propertyLinks];
if (combined.length === 0) {
  trace('definition.result', { links: 0 });
  return null;
}
trace('definition.result', {
  links: combined.length,
  hlsl: links.length,
  properties: propertyLinks.length,
});
return combined;
```

Important: the existing `links` array is built from
`resolveDefinition(idx, word.text, ...)`. The forward branch above returns
*before* the reverse branch is reached, so a cursor on a property name
never double-fires (forward + reverse).

**Step 4: Server-unit tests** (`definition-properties.test.ts`)

Pattern: fork `definition.test.ts`'s `createDefinitionFixture` to take a
*pair* of files (shader + hlsl) so both indices live in the same
`IndexStore`, and so `workspace.global.upsert` is called for each.

Cases:
1. **Forward, same-file declaration.** Shader has `Properties { _MainTex
   ("Base", 2D) = "white" {} }` plus an `HLSLPROGRAM` block declaring
   `TEXTURE2D(_MainTex);`. Cursor on `_MainTex` in the Properties line
   → exactly one link, targeting the HLSL declaration range.
2. **Forward, declaration in included `.hlsl`.** Shader has the property
   plus `#include "Lib.hlsl"`; `Lib.hlsl` declares `float4 _MainTex_ST;`
   and `float _BumpScale;`. (Note: ST suffix is for tiling; the user
   navigates `_MainTex`, not `_MainTex_ST`. The match here is on
   `_BumpScale` to exercise the include-visible case cleanly. Use a
   separate fixture for the ST-suffix follow-up — see Out of Scope.)
   The test asserts visibility filtering via a stubbed
   `collectVisibleUriKeys`.
3. **Forward, no matching HLSL declaration.** Cursor on `_Color` whose
   property exists but no HLSL global of that name is visible → handler
   returns `null` (not `[]`; mirror the existing convention).
4. **Forward, multiple HLSL declarations with the same name** (e.g.
   `#ifdef`-gated double declaration) → all candidates returned, none
   prioritised (ADR-0001).
5. **Forward, cursor on property type token** (`2D`) → handler returns
   `null` because `propertyAt` matches only the name range. Confirms
   design decision 4.
6. **Reverse, HLSL identifier → property in same shader.** Cursor on
   `_MainTex` inside the HLSL block of the shader → links include both
   the HLSL declaration (existing behavior) **and** the property entry
   (new). Property link's `targetSelectionRange` is the property name
   range and `targetRange` is the declaration range.
7. **Reverse, HLSL identifier in `.hlsl` include → properties in
   indexed shaders.** Two shaders both declare `_MainTex` in their
   Properties; both include `Lib.hlsl` which declares `_MainTex`.
   Cursor on `_MainTex` *inside* `Lib.hlsl` → returns the HLSL
   declaration plus **both** property entries. Acceptance criterion 4.
8. **Reverse, no shader has a matching property** → behavior identical
   to today (links from `resolveDefinition` only).
9. **`isGenericDefinitionContext` regression.** Cursor inside `Tags {
   "RenderType" = "Opaque" }` returns `null`; cursor inside `Pass {
   Name "Forward" }` returns `null`; cursor inside a `//` comment in
   the Properties block returns `null`; cursor on a property name
   *inside a string literal* returns `null` (the lexical gate's
   string check fires before the property predicate would).
10. **Comment between Properties block and a property line.** A `//
    legacy_prop ("...", 2D) = "white" {}` line must not be picked up
    as a property entry. Confirms the scanner respects line comments.

**Step 5: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav\server
npx vitest run
```

All 10 cases pass; no existing test regresses (in particular,
`definition.test.ts` must still pass byte-for-byte because the new
branches are no-ops when the cursor is not on a property name and no
property candidates exist).

**Commit:** `feat(issue-20): bridge Properties ↔ HLSL F12 navigation`

---

## Task 5: Electron integration smoke

**Files:**
- Create: `unity-shader-nav/tests/integration/client/fixtures/properties-inline-hlsl.shader`
- Create: `unity-shader-nav/tests/integration/client/fixtures/properties-include/Inline.shader`
- Create: `unity-shader-nav/tests/integration/client/fixtures/properties-include/Lib.hlsl`
- Create: `unity-shader-nav/tests/integration/client/properties-to-hlsl.test.ts`

**Step 1: Fixture `properties-inline-hlsl.shader`**

```shaderlab
Shader "Test/PropertiesInlineHlsl" {
  Properties {
    _MainTex ("Base Map", 2D) = "white" {}
    _BaseColor ("Tint", Color) = (1,1,1,1)
  }
  SubShader {
    Pass {
      HLSLPROGRAM
      TEXTURE2D(_MainTex);
      float4 _BaseColor;
      void frag() { /* uses _MainTex, _BaseColor */ }
      ENDHLSL
    }
  }
}
```

**Step 2: Fixture `properties-include/`**

`Lib.hlsl`:
```hlsl
TEXTURE2D(_MainTex);
SAMPLER(sampler_MainTex);
float4 _BaseColor;
```

`Inline.shader`:
```shaderlab
Shader "Test/PropertiesInclude" {
  Properties {
    _MainTex ("Base Map", 2D) = "white" {}
    _BaseColor ("Tint", Color) = (1,1,1,1)
  }
  SubShader {
    Pass {
      HLSLPROGRAM
      #include "Lib.hlsl"
      void frag() {}
      ENDHLSL
    }
  }
}
```

**Step 3: Test cases**

Mirror `definition.test.ts`'s `waitForDefinitions(uri, pos, predicate)`
helper. Cover:

1. **Forward inline:** Open `properties-inline-hlsl.shader`, cursor on
   `_MainTex` in the Properties line. Expect at least one definition link
   whose target range starts on the line containing `TEXTURE2D(_MainTex);`.
2. **Forward inline, Color:** Cursor on `_BaseColor` in Properties.
   Expect at least one link whose target line contains
   `float4 _BaseColor;`.
3. **Forward via include:** Open `properties-include/Inline.shader`,
   cursor on `_MainTex` in Properties. Expect at least one link whose
   target URI ends with `Lib.hlsl`.
4. **Reverse inline:** Same shader as case 1, cursor on `_MainTex` inside
   the HLSL block (the `TEXTURE2D(...)` line). Expect ≥ 2 links — one
   to the HLSL declaration itself (selection range equals the cursor
   word) and one to the property entry (selection range is the property
   name). Assert at least one target URI ends with the same `.shader`
   AND at least one target line equals the property line.
5. **No match negative:** Cursor on `_DoesNotExist` *manually inserted*
   in the Properties block (extra line in a third fixture, or via a
   per-test workspace edit) → no definition link surfaces, command
   resolves to `undefined` or `[]`.

**Step 4: Verify**

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
npm test
```

Mocha runs all electron tests under `tests/integration/client/`. The new
file integrates via the existing rig — no `index.ts` registration needed
(the loader picks up `**/*.test.ts`).

**Commit:** `test(issue-20): cover Properties ↔ HLSL integration`

---

## Task 6: Document the feature

**Files:**
- Edit: `unity-shader-nav/docs/usage.md` (if it already documents F12 —
  verify; the file may be under `docs/usage.md` at repo root instead)
- Edit: `CHANGELOG.md`

**Step 1: Usage section**

Add a short subsection under the F12 documentation:

> **Navigate between Properties and HLSL.** F12 / Go to Definition on a
> ShaderLab property name (e.g. `_MainTex` in `Properties { ... }`) jumps to
> the HLSL/CG declaration of the same name, when one is visible from the
> current shader. F12 on the HLSL declaration or reference also surfaces
> the matching property entry. When several declarations share the name,
> VS Code's Peek menu lists every candidate without picking one — the
> resolver remains conservative (see ADR-0001).

**Step 2: Changelog**

Append to `CHANGELOG.md` under the unreleased / next-version block:

```
- feat: bridge ShaderLab Properties ↔ HLSL declarations for F12 navigation
  in both directions (issue #20).
```

**Step 3: Verify**

No build/test impact. `git diff CHANGELOG.md docs/usage.md` shows the
documentation deltas only.

**Commit:** `docs(issue-20): document Properties ↔ HLSL navigation`

---

## Verification (end-to-end)

After every commit, run from `unity-shader-nav/`:

```powershell
npm run build
npx vitest run --root server
npm test
```

Acceptance map:

| Acceptance criterion | Covered by |
| --- | --- |
| GtD from Property → HLSL declaration | Task 4 forward branch, Task 5 case 1 & 3 |
| GtD from HLSL declaration/reference → Property | Task 4 reverse branch, Task 5 case 4 |
| Handles common texture/color/vector/float/range/scalar shapes | Task 2 `PROPERTY_TYPES`, Task 2 tests; Task 5 fixtures cover 2D + Color |
| Ambiguous same-name → multiple locations | Task 4 case 4 + case 7 |
| `.shader` with inline HLSL + include-visible HLSL covered | Task 5 fixtures `properties-inline-hlsl.shader` + `properties-include/` |

---

## Out of Scope (explicit non-goals)

- **Suffix-aware matching (`_MainTex` ↔ `_MainTex_ST`, `_MainTex_TexelSize`,
  `_MainTex_HDR`).** Unity auto-generates several HLSL globals from a
  single `2D` property. v1 matches only the exact name; the user can
  navigate the ST suffix via the HLSL declaration itself today. Adding
  suffix-aware bridging is a follow-up issue.
- **`MaterialPropertyBlock` / scripted material overrides.** Properties
  set in C# via `material.SetFloat("_X", v)` have no `.shader` entry and
  are invisible to this bridge. Scoping the bridge to indexed
  declarations is design decision 10.
- **Tokeniser fix for `CubeArray`.** `tokenScanner.ts:45-54` currently
  does not include `CubeArray` in its semantic-highlighting whitelist.
  This plan's scanner *does* recognise `CubeArray`, but does not patch
  the tokeniser — that is a separate semantic-highlighting bug.
- **Properties block hover.** Cursor hovering a property name does not
  surface declaration text in v1. Issue 18 already excludes ShaderLab
  declarative sections explicitly; revisit when that exclusion is
  relaxed.
- **Find References across the Properties ↔ HLSL bridge.** F12 is
  bidirectional; Shift-F12 is not. Reference counts should not include
  property declarations or reverse-direction hits in v1 (design
  decision 2 — bridge lives in the handler, not the resolver).
- **`#pragma shader_feature _SOMETHING_ON` ↔ `Properties { [Toggle]
  _SOMETHING_ON ("...", Float) = 0 }` bridging.** Shader-feature
  toggling is a separate workflow (declaration vs. keyword). v1 ignores
  the `[Toggle]` / `[KeywordEnum]` decorator semantics — names match by
  string equality only.
- **Property override files (`.mat` YAML).** `.mat` files are not parsed
  by this extension at all; nothing in this PR changes that.
- **Trace/debug setting for the bridge.** The existing `debug.definitionTrace`
  setting already covers the definition handler; the new branches emit
  trace events via the same channel (`'property.hit'`, `'property.forward'`,
  `'definition.result'` already extended in Task 4). No new setting key is
  introduced.

---

## Risks

- **Perf:** `isGenericDefinitionContext` now calls `scanProperties` once
  per F12 request (and once per hover request, after #18 lands). For a
  large `.shader` file this is one regex pass per non-comment line. The
  scanner is O(N) over text; benchmark in Task 4 Step 5 only if a real
  shader (e.g. URP `Lit.shader`) shows a regression — otherwise accept
  the cost.
- **Cross-shader noise:** The reverse direction's name-only matching
  (design decision 3) can surface a property from an unrelated shader
  that happens to share the name (`_MainTex` is *everywhere*). VS Code
  Peek surfaces every candidate, so the user sees the list and picks. If
  feedback complaints arrive, the follow-up is to filter to shaders
  whose HLSL blocks declare the same identifier.
- **`.shader` reindex cost:** Properties go through `indexFile` on every
  `did-change`. The scanner is line-oriented and runs in O(lines), which
  is cheaper than the existing HLSL block tree-sitter parse, so net
  index time should be unchanged within noise.

---

## Plan Authoring Commits

This plan file is committed in two phases:

1. **Initial draft** (this file as written):

   ```powershell
   cd F:\Project\UnityShaderNav
   git add docs/plans/2026-05-28-issue-20-properties-to-hlsl-navigation.md
   git commit -m "docs(issue-20): draft properties-to-HLSL navigation plan"
   ```

2. **After independent review** (see Review Notes below — appended after the
   reviewer subagent runs):

   ```powershell
   git add docs/plans/2026-05-28-issue-20-properties-to-hlsl-navigation.md
   git commit -m "docs(issue-20): apply plan review feedback"
   ```

The per-task `feat(issue-20)` / `test(issue-20)` / `docs(issue-20): document
...` commits are for the future execution of this plan, not for these
plan-writing changes.

---

## Review Notes

_(Reviewer subagent output and the line-by-line resolution will be appended
here in the second plan-authoring commit.)_
