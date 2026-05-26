# Project Symbol Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement issue #15 by adding LSP completion for indexed project shader symbols in HLSL/CG code contexts.

**Architecture:** Add a new `server/src/suggestions/` layer that owns completion context, project-symbol enumeration, member enumeration, and LSP item formatting. Keep `server/src/handlers/completion.ts` thin: it should fetch the document/workspace, ensure the open document is indexed, collect visible symbols, and return formatted completion items.

**Tech Stack:** TypeScript, VS Code Language Server Protocol, `vscode-languageserver`, `vscode-languageserver-textdocument`, Vitest, VS Code integration tests.

---

## Prerequisites

- Read `docs/plans/2026-05-26-shader-completion-roadmap.md`.
- Do not create a `codex/` branch; the repository forbids that prefix.
- Work from repository root `F:\Project\UnityShaderNav`.
- Run commands from `F:\Project\UnityShaderNav\unity-shader-nav` unless a task says otherwise.
- For git commands, run from `F:\Project\UnityShaderNav` or use `git -C F:\Project\UnityShaderNav ...`.
- Focused server test filters are relative to the server package, for example `tests/suggestions/format.test.ts`, not `server/tests/...`.

## Design Constraints

- This issue must not add Unity/HLSL built-in completions. That belongs to #17.
- This issue must create shared suggestion types and formatting that #16 and #17 can reuse.
- Completion must not reuse `isGenericDefinitionContext` as the only context gate. It should create a richer context model where `shaderLabCode` exists but returns no project-symbol completions for #15.
- Completion needs symbol enumeration, not exact-name definition resolution. Use `IndexStore.uris()` plus `collectVisibleUriKeys`.
- Member completion needs all members for an inferred receiver type, not `resolveMemberSymbols(receiver, member)` with a known member name.

## Task 1: Advertise Completion Capability

**Files:**
- Modify: `unity-shader-nav/server/src/connection.ts`
- Test: `unity-shader-nav/server/tests/handshake.test.ts`

**Step 1: Write the failing handshake test**

Add a test:

```ts
it('advertises completionProvider', () => {
  const result = createInitializeResult();
  expect(result.capabilities.completionProvider).toMatchObject({
    triggerCharacters: ['.'],
  });
});
```

**Step 2: Run the focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handshake.test.ts
```

Expected: FAIL because `completionProvider` is undefined.

**Step 3: Add the capability**

In `createInitializeResult`, add:

```ts
completionProvider: {
  triggerCharacters: ['.'],
},
```

Keep existing capabilities unchanged.

**Step 4: Re-run the focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handshake.test.ts
```

Expected: PASS.

## Task 2: Add Shared Suggestion Types And Formatting

**Files:**
- Create: `unity-shader-nav/server/src/suggestions/types.ts`
- Create: `unity-shader-nav/server/src/suggestions/format.ts`
- Create: `unity-shader-nav/server/src/suggestions/index.ts`
- Test: `unity-shader-nav/server/tests/suggestions/format.test.ts`

**Step 1: Write failing formatter tests**

Create tests that assert:

- A function suggestion maps to `CompletionItemKind.Function`.
- Function `detail` includes return type and parameter summary.
- A variable/local/parameter suggestion maps to the expected LSP kind.
- `ShaderParameter` does not require source ranges.

Example assertions:

```ts
const item = toCompletionItem({
  name: 'Lighting',
  kind: 'function',
  source: 'project',
  returnType: 'float4',
  parameters: [{ name: 'normalWS', type: 'float3' }],
});

expect(item.label).toBe('Lighting');
expect(item.kind).toBe(CompletionItemKind.Function);
expect(item.detail).toBe('float4 Lighting(float3 normalWS)');
```

**Step 2: Run the focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/format.test.ts
```

Expected: FAIL because the files/functions do not exist.

**Step 3: Implement the shared types**

In `types.ts`, define:

```ts
import type { SymbolKind } from '@unity-shader-nav/shared';

export type ShaderSuggestionSource = 'project' | 'builtin';
export type ShaderSuggestionKind = SymbolKind | 'keyword' | 'semantic' | 'state' | 'function' | 'type';

export interface ShaderParameter {
  name: string;
  type: string;
  documentation?: string;
}

export interface ShaderSuggestion {
  name: string;
  kind: ShaderSuggestionKind;
  source: ShaderSuggestionSource;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
  returnType?: string;
  parameters?: ShaderParameter[];
  declaredType?: string;
  parentType?: string;
}
```

**Step 4: Implement formatter helpers**

In `format.ts`, implement:

- `signatureLabelOf(suggestion: ShaderSuggestion): string`
- `toCompletionItem(suggestion: ShaderSuggestion): CompletionItem`
- `symbolKindToCompletionItemKind(kind: ShaderSuggestionKind): CompletionItemKind`

Rules:

- Functions use `CompletionItemKind.Function`.
- Structs use `CompletionItemKind.Struct`.
- Struct members use `CompletionItemKind.Field`.
- Parameters use `CompletionItemKind.Variable`.
- Macros use `CompletionItemKind.Constant`.
- `detail` for functions should be `returnType name(type param, ...)`.
- `detail` for typed variables should be `declaredType name`.
- Preserve `insertText` and `sortText` when provided.

**Step 5: Re-run formatter tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/format.test.ts
```

Expected: PASS.

## Task 3: Add Completion Context And Prefix Detection

**Files:**
- Create: `unity-shader-nav/server/src/suggestions/context.ts`
- Test: `unity-shader-nav/server/tests/suggestions/context.test.ts`

**Step 1: Write failing context tests**

Cover:

- `.hlsl` code returns `hlslCode`.
- `.shader` inside `HLSLPROGRAM` returns `hlslCode`.
- `.shader` outside HLSL/CG blocks returns `shaderLabCode`.
- Line/block comments return `comment`.
- String literals return `string`.
- `surface.` returns a member context with empty prefix.
- `surface.pos` returns a member context with prefix `pos`.
- `lights[i].` returns receiver `lights[i]` with empty member prefix.
- `surface.brdfData.` returns receiver `surface.brdfData` with empty member prefix.
- Ordinary partial identifier `Lig` returns prefix `Lig`.
- Whitespace in HLSL returns empty prefix.

**Step 2: Run the focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/context.test.ts
```

Expected: FAIL.

**Step 3: Implement context helpers**

Export:

```ts
export type SuggestionContextKind =
  | 'hlslCode'
  | 'shaderLabCode'
  | 'comment'
  | 'string';

export interface CompletionPrefix {
  text: string;
  range: Range;
}

export interface SuggestionContext {
  kind: SuggestionContextKind;
  prefix: CompletionPrefix;
  member?: {
    receiver: string;
    memberPrefix: CompletionPrefix;
  };
}

export function suggestionContextAt(
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): SuggestionContext;
```

Implementation notes:

- Copy or extract lexical scanning behavior from `parser/lexical/context.ts`; keep behavior consistent with navigation for comments/strings.
- Use `scanBlocks` to classify `.shader` positions as HLSL/CG block or ShaderLab outer code.
- Add a completion-specific prefix helper that allows empty prefixes.
- Detect member context by looking for a `.` before the member prefix; support `receiver.` and `receiver.pa`.
- Keep receiver parsing single-line for #15.
- Prefer extracting or adapting the existing receiver-expression scanner from `server/src/index/wordAt.ts` so nested and array receiver shapes stay aligned with navigation, but add completion-specific support for an empty member prefix after `.`.

**Step 4: Re-run context tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/context.test.ts
```

Expected: PASS.

## Task 4: Add Project Symbol Enumeration

**Files:**
- Create: `unity-shader-nav/server/src/suggestions/projectSymbols.ts`
- Modify: `unity-shader-nav/server/src/suggestions/index.ts`
- Test: `unity-shader-nav/server/tests/suggestions/projectSymbols.test.ts`

**Step 1: Write failing project symbol tests**

Cover:

- Same-file function/global/struct suggestions.
- Include-visible global function suggestions.
- Non-included global symbols are excluded.
- Locals/parameters appear only inside `scopeRange` and after declaration.
- Later same-name local shadows earlier display group.
- Results order is local/parameter, same-file global, include-visible global.
- Duplicate same display group is deduped.
- Two same-name functions with different parameter type lists or distinct source ranges are preserved as separate candidates.

**Step 2: Run the focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/projectSymbols.test.ts
```

Expected: FAIL.

**Step 3: Implement enumeration**

Export:

```ts
export interface CollectProjectSuggestionsInput {
  index: FileIndex;
  store: Pick<IndexStore, 'get' | 'uris'>;
  visibleUriKeys: ReadonlySet<string>;
  position: Position;
}

export function collectVisibleProjectSuggestions(
  input: CollectProjectSuggestionsInput,
): ShaderSuggestion[];
```

Implementation rules:

- Same-file symbols come from `index.symbols`.
- Include-visible symbols come from each URI in `store.uris()` whose `uriKey` is in `visibleUriKeys`.
- Do not include parameter/local symbols from other files.
- For parameters/locals: require `scopeRange`, `position` inside it, and declaration start before or at `position`.
- Map indexed `FunctionSymbolEntry.parameters` to `ShaderParameter[]` without ranges.
- Use stable `sortText` prefixes like `0_`, `1_`, `2_` for local/same-file/include-visible ordering.
- Dedupe non-functions by `name + kind + parentType` with first-result-wins ordering.
- For functions, preserve candidates with distinct parameter type lists or distinct source ranges. This is required so #16 can show overload-like signatures.
- Expose a raw symbol-to-suggestion mapper, for example `symbolToSuggestion(symbol, sourceRank)`, so #16 can collect function candidates without completion-display dedupe if needed.

**Step 4: Re-run project symbol tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/projectSymbols.test.ts
```

Expected: PASS.

## Task 5: Add Member Enumeration For Completion

**Files:**
- Modify: `unity-shader-nav/server/src/index/chainLookup.ts`
- Modify: `unity-shader-nav/server/src/index/index.ts`
- Create: `unity-shader-nav/server/src/suggestions/memberContext.ts`
- Test: `unity-shader-nav/server/tests/suggestions/memberContext.test.ts`
- Test: `unity-shader-nav/server/tests/index/chainLookup.test.ts`

**Step 1: Write failing member tests**

Cover:

- `surface.` suggests all members for `Surface`.
- `surface.pos` filters to members starting with `pos`.
- `lights[i].` works for array receiver shapes currently supported by chain lookup.
- `surface.brdfData.` works for nested receiver shapes currently supported by chain lookup.
- Unknown receiver type returns an empty list.

**Step 2: Run focused tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/memberContext.test.ts tests/index/chainLookup.test.ts
```

Expected: FAIL.

**Step 3: Extract receiver type support**

In `chainLookup.ts`, export a narrow receiver-type helper without changing existing `resolveMember` behavior:

```ts
export function inferReceiverTypeForCompletion(
  index: FileIndex,
  global: GlobalSymbolIndex | null | undefined,
  receiver: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null;
```

Implementation note:

- This can wrap the current private `inferReceiverExpressionType`.
- Keep existing `resolveMemberSymbols` behavior unchanged.
- Do not add broad enumeration APIs to `GlobalSymbolIndex` for this issue.

**Step 4: Implement `memberContext.ts`**

Export:

```ts
export function collectMemberSuggestions(
  index: FileIndex,
  store: Pick<IndexStore, 'get' | 'uris'>,
  global: GlobalSymbolIndex | null | undefined,
  visibleUriKeys: ReadonlySet<string>,
  receiver: string,
  memberPrefix: string,
  position: Position,
): ShaderSuggestion[];
```

Implementation rules:

- Call `inferReceiverTypeForCompletion(index, global, receiver, position, { visibleUriKeys })`.
- If receiver type is unknown, return `[]`.
- Enumerate candidate indexes through `[index, ...store.uris() filtered by visibleUriKeys]`.
- Filter symbols where `kind === 'structMember'`, `parentType === receiverType`, and `name` starts with `memberPrefix`.
- Map to `ShaderSuggestion`.
- Dedupe by `name + parentType`, first result wins.

**Step 5: Re-run focused tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/memberContext.test.ts tests/index/chainLookup.test.ts
```

Expected: PASS.

## Task 6: Register The Completion Handler

**Files:**
- Create: `unity-shader-nav/server/src/handlers/completion.ts`
- Modify: `unity-shader-nav/server/src/server.ts`
- Test: `unity-shader-nav/server/tests/handlers/completion.test.ts`

**Step 1: Write failing handler tests**

Use the style of `server/tests/handlers/definition.test.ts`: fake a `Connection`, capture `onCompletion`, create `TextDocument`, fake workspace/manager.

Cover:

- Handler returns same-file function completion.
- Handler reindexes open document on store miss.
- Handler returns include-visible function completion.
- Handler rejects comments and strings.
- Handler returns no project-symbol completions in ShaderLab outer code.
- Handler returns member completions for `receiver.`.
- Handler returns member completions for `lights[i].` and `surface.brdfData.` when those receiver shapes are index-supported.
- Handler waits on `RequestSuspender`.

**Step 2: Run focused handler test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handlers/completion.test.ts
```

Expected: FAIL.

**Step 3: Implement handler**

Use this flow:

1. Get document from `documents.get`.
2. Get workspace from `manager.workspaceForOrCreateFile`.
3. Get `fullText`.
4. Build `suggestionContextAt`.
5. Return `null` or `[]` for `comment`, `string`, and `shaderLabCode`.
6. Ensure index exists; if store misses and `workspace.reindex` exists, reindex open document.
7. Build `visibleUriKeys = await collectVisibleUriKeys(...)`.
8. If `context.member`, call `collectMemberSuggestions(index, workspace.store, workspace.global, visibleUriKeys, ...)`; otherwise call `collectVisibleProjectSuggestions`.
9. Filter suggestions by prefix.
10. Return `suggestions.map(toCompletionItem)`.
11. Wrap with `suspender.run` when provided.

Register in `server.ts` after semantic tokens/references imports:

```ts
import { registerCompletionHandler } from './handlers/completion';
...
registerCompletionHandler(connection, documents, manager, suspender);
```

**Step 4: Re-run handler tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handlers/completion.test.ts
```

Expected: PASS.

## Task 7: Add VS Code Integration Coverage

**Files:**
- Create or modify: `unity-shader-nav/tests/integration/client/completion.test.ts`
- Modify only if needed: `unity-shader-nav/tests/integration/client/fixtures/single-file/test.hlsl`

**Step 1: Add post-wiring integration coverage**

Use `vscode.executeCompletionItemProvider`:

```ts
const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
  'vscode.executeCompletionItemProvider',
  uri,
  new vscode.Position(line, character),
);
assert.ok(completions.items.some((item) => item.label === 'helper'));
```

Add one member completion assertion if fixture has a simple struct receiver; otherwise keep integration to ordinary project symbols and rely on handler tests for member completion.

**Step 2: Run integration test path**

Run:

```powershell
npm test
```

Expected: PASS after Task 6. This is intentionally full VS Code regression coverage rather than the tight red/green unit loop.

## Task 8: Update Documentation

**Files:**
- Modify: `docs/technical-spec.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.ja.md` if it mirrors feature bullets

**Step 1: Update spec non-goals**

Change `Formatting or completion.` to narrower language, for example:

```md
- Formatting or exhaustive compiler-grade completion.
```

Add a short goal/feature note that completion is project-index-backed and conservative.

**Step 2: Update public README bullets**

Mention project-symbol completion carefully. Do not imply built-in Unity/HLSL vocabulary or full IDE-grade autocomplete yet.

## Task 9: Final Verification And Commit

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
  unity-shader-nav/server/src/connection.ts `
  unity-shader-nav/server/src/server.ts `
  unity-shader-nav/server/src/handlers/completion.ts `
  unity-shader-nav/server/src/suggestions `
  unity-shader-nav/server/src/index/chainLookup.ts `
  unity-shader-nav/server/src/index/index.ts `
  unity-shader-nav/server/tests/handshake.test.ts `
  unity-shader-nav/server/tests/handlers/completion.test.ts `
  unity-shader-nav/server/tests/suggestions `
  unity-shader-nav/server/tests/index/chainLookup.test.ts `
  unity-shader-nav/tests/integration/client/completion.test.ts `
  docs/technical-spec.md `
  README.md `
  README.zh-CN.md `
  README.ja.md
git status --short
git commit -m "feat(issue-15): add project symbol completion"
```

Expected: one commit for issue #15 only.
