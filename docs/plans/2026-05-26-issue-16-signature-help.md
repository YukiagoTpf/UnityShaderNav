# Shader Function Signature Help Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement issue #16 by adding conservative signature help for indexed project shader functions.

**Architecture:** Reuse the `server/src/suggestions/` model and formatter from #15. Add call-context detection and a thin LSP signature-help handler that resolves visible project function suggestions, formats them as signatures, and returns active parameter information.

**Tech Stack:** TypeScript, VS Code Language Server Protocol, `vscode-languageserver`, `vscode-languageserver-textdocument`, Vitest, VS Code integration tests.

---

## Prerequisites

- Issue #15 must be merged first.
- Read `docs/plans/2026-05-26-shader-completion-roadmap.md`.
- Read `docs/plans/2026-05-26-issue-15-project-symbol-completion.md`.
- Do not create a `codex/` branch; the repository forbids that prefix.
- Do not add Unity/HLSL built-in signature help here. Built-ins belong to #17.
- Work from repository root `F:\Project\UnityShaderNav`.
- Run npm commands from `F:\Project\UnityShaderNav\unity-shader-nav` unless a task says otherwise.
- For git commands, run from `F:\Project\UnityShaderNav` or use `git -C F:\Project\UnityShaderNav ...`.
- Focused server test filters are relative to the server package, for example `tests/suggestions/callContext.test.ts`, not `server/tests/...`.

## Design Constraints

- Use the same `ShaderSuggestion` and `ShaderParameter` shape created in #15.
- Do not create a second function-signature formatter.
- Do not evaluate overload resolution or preprocessor conditions.
- Return multiple signatures for ambiguous function candidates.
- Preserve overload-like function candidates from #15 by concrete symbol identity (`uri + range`) rather than display-label dedupe.
- Fail quietly with `null` when context is too ambiguous.
- Trigger on `(` and `,`; do not trigger on `)` unless a failing test proves value.

## Task 1: Advertise Signature Help Capability

**Files:**
- Modify: `unity-shader-nav/server/src/connection.ts`
- Test: `unity-shader-nav/server/tests/handshake.test.ts`

**Step 1: Write the failing handshake test**

Add:

```ts
it('advertises signatureHelpProvider', () => {
  const result = createInitializeResult();
  expect(result.capabilities.signatureHelpProvider).toMatchObject({
    triggerCharacters: ['(', ','],
    retriggerCharacters: [','],
  });
});
```

If the installed `vscode-languageserver` type does not accept `retriggerCharacters`, keep only `triggerCharacters` and document that choice in the test name/comment.

**Step 2: Run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handshake.test.ts
```

Expected: FAIL because the capability is absent.

**Step 3: Add capability**

In `createInitializeResult`, add:

```ts
signatureHelpProvider: {
  triggerCharacters: ['(', ','],
  retriggerCharacters: [','],
},
```

Keep #15's `completionProvider` unchanged.

**Step 4: Re-run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handshake.test.ts
```

Expected: PASS.

## Task 2: Extend The Formatter For Signature Help

**Files:**
- Modify: `unity-shader-nav/server/src/suggestions/format.ts`
- Test: `unity-shader-nav/server/tests/suggestions/format.test.ts`

**Step 1: Write failing formatter tests**

Add tests for:

- `toSignatureInformation` formats `float4 Lighting(float3 normalWS, half roughness)`.
- Parameter labels are substrings or explicit `[start, end]` ranges accepted by LSP.
- Documentation is preserved when present.
- Non-function suggestions return `null` or are ignored by a helper that filters functions.

**Step 2: Run formatter test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/format.test.ts
```

Expected: FAIL.

**Step 3: Implement signature formatting**

Add helpers:

```ts
export function isFunctionSuggestion(suggestion: ShaderSuggestion): boolean;
export function toSignatureInformation(suggestion: ShaderSuggestion): SignatureInformation | null;
```

Rules:

- Use the same signature label logic as completion detail.
- Include one `ParameterInformation` per `ShaderParameter`.
- Do not require source ranges.
- Keep this helper generic so #17 built-ins can use it unchanged.

**Step 4: Re-run formatter test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/format.test.ts
```

Expected: PASS.

## Task 3: Add Call Context Detection

**Files:**
- Create: `unity-shader-nav/server/src/suggestions/callContext.ts`
- Modify: `unity-shader-nav/server/src/suggestions/index.ts`
- Test: `unity-shader-nav/server/tests/suggestions/callContext.test.ts`

**Step 1: Write failing call-context tests**

Cover:

- `Lighting(` returns callee `Lighting`, active parameter `0`.
- `Lighting(normalWS, ` returns active parameter `1`.
- `Lighting(float3(0, 1, 0), roughness` counts nested call commas correctly.
- Empty call `Lighting()` at position inside parentheses returns active parameter `0`.
- Member-style call `surface.Lighting(` returns `null` for this issue.
- Position outside a call returns `null`.
- Unbalanced or multi-line ambiguous contexts return `null`.
- Comments/strings are not accepted when combined with `suggestionContextAt`.

**Step 2: Run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/callContext.test.ts
```

Expected: FAIL.

**Step 3: Implement `callContextAt`**

Export:

```ts
export interface CallContext {
  calleeName: string;
  calleeRange: Range;
  argumentListStart: Position;
  activeParameter: number;
}

export function callContextAt(text: string, position: Position): CallContext | null;
```

Implementation approach:

- Work on the current line first; do not attempt complex multi-line parsing for this issue.
- Walk backward from `position` to find the nearest unmatched `(`.
- Track nested `()`, `[]`, and `{}` while walking/counting.
- Read the identifier immediately before the call `(` as callee.
- Reject member-call contexts when the character before the callee token is `.`. #16 covers free-function shader calls only.
- Count top-level commas between `(` and `position` for `activeParameter`.
- Return `null` if callee is missing or syntax is too ambiguous.

**Step 4: Re-run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/callContext.test.ts
```

Expected: PASS.

## Task 4: Add Project Function Candidate Collection

**Files:**
- Modify: `unity-shader-nav/server/src/suggestions/projectSymbols.ts`
- Test: `unity-shader-nav/server/tests/suggestions/projectSymbols.test.ts`

**Step 1: Write failing tests**

Add tests for:

- Collect visible function suggestions by exact callee name.
- Same-file function is included.
- Include-visible function is included.
- Non-visible function is excluded.
- Multiple visible function candidates with the same name are preserved.
- Non-function symbols with same name are excluded for signature help.
- Function candidates are deduped only by concrete symbol identity, for example `uri + range`, not by completion display group.

**Step 2: Run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/projectSymbols.test.ts
```

Expected: FAIL.

**Step 3: Implement helper**

Add:

```ts
export function collectVisibleProjectFunctionSuggestions(
  input: CollectProjectSuggestionsInput & { name: string },
): ShaderSuggestion[];
```

Implementation rules:

- Reuse the enumeration and mapping from #15.
- Filter to function suggestions with `suggestion.name === input.name`.
- Preserve multiple candidates if they point to distinct function symbols.
- Use the raw symbol-to-suggestion mapper or a `{ preserveFunctionCandidates: true }` path from #15. Do not call a completion-display-deduped helper if it can collapse overload-like function candidates.

**Step 4: Re-run focused test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/suggestions/projectSymbols.test.ts
```

Expected: PASS.

## Task 5: Register Signature Help Handler

**Files:**
- Create: `unity-shader-nav/server/src/handlers/signatureHelp.ts`
- Modify: `unity-shader-nav/server/src/server.ts`
- Test: `unity-shader-nav/server/tests/handlers/signatureHelp.test.ts`

**Step 1: Write failing handler tests**

Use the same fake connection style as definition/completion handler tests.

Cover:

- Same-file function returns one signature.
- Active parameter is `0` after `Lighting(`.
- Active parameter is `1` after first comma.
- Include-visible function returns a signature.
- Ambiguous same-name visible functions return multiple signatures.
- Unknown callee returns `null`.
- Same-name non-function-only symbols return `null`.
- Formatter-null results are filtered before returning.
- Comments/strings return `null`.
- Handler reindexes open document on store miss.
- Handler waits on `RequestSuspender`.

**Step 2: Run focused handler test**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handlers/signatureHelp.test.ts
```

Expected: FAIL.

**Step 3: Implement handler**

Use this flow:

1. Get document and workspace.
2. Build `suggestionContextAt`; return `null` for `comment`, `string`, and `shaderLabCode`.
3. Build `callContextAt`; return `null` if absent.
4. Ensure index exists; reindex open document on store miss.
5. Build `visibleUriKeys`.
6. Call `collectVisibleProjectFunctionSuggestions({ name: call.calleeName, ... })`.
7. Convert suggestions with `toSignatureInformation`.
8. Filter `null` signatures.
9. If `signatures.length === 0`, return `null`.
10. Return:

```ts
{
  signatures,
  activeSignature: 0,
  activeParameter: Math.min(call.activeParameter, maxParameterIndex),
}
```

Use a conservative `activeParameter`: if there are no parameters, set `0`.

**Step 4: Register handler in `server.ts`**

Add import:

```ts
import { registerSignatureHelpHandler } from './handlers/signatureHelp';
```

Register near completion:

```ts
registerSignatureHelpHandler(connection, documents, manager, suspender);
```

**Step 5: Re-run handler tests**

Run:

```powershell
npm run test -w @unity-shader-nav/server -- tests/handlers/signatureHelp.test.ts
```

Expected: PASS.

## Task 6: Add VS Code Integration Coverage

**Files:**
- Create: `unity-shader-nav/tests/integration/client/signature-help.test.ts`
- Modify only if needed: `unity-shader-nav/tests/integration/client/fixtures/single-file/test.hlsl`

**Step 1: Add post-wiring integration coverage**

Use:

```ts
const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
  'vscode.executeSignatureHelpProvider',
  uri,
  new vscode.Position(line, character),
  '(',
);
assert.ok(help.signatures.some((signature) => signature.label.includes('helper')));
```

Assert active parameter for a two-argument fixture if available; otherwise add a tiny fixture function.
Add `assert.ok(help, 'expected signature help')` before reading `help.signatures`.

**Step 2: Run integration path**

Run:

```powershell
npm test
```

Expected: PASS after handler wiring. This is full VS Code regression coverage rather than the tight red/green unit loop.

## Task 7: Update Documentation

**Files:**
- Modify: `docs/technical-spec.md`
- Modify: `docs/usage.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.ja.md` if it mirrors feature bullets

**Step 1: Document behavior**

Add concise wording:

- Signature help is index-backed.
- It is conservative.
- It may show multiple candidates when preprocessing/overload-like ambiguity exists.
- Built-in Unity/HLSL function signatures are not promised until #17.

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
  unity-shader-nav/server/src/connection.ts `
  unity-shader-nav/server/src/server.ts `
  unity-shader-nav/server/src/handlers/signatureHelp.ts `
  unity-shader-nav/server/src/suggestions `
  unity-shader-nav/server/tests/handshake.test.ts `
  unity-shader-nav/server/tests/handlers/signatureHelp.test.ts `
  unity-shader-nav/server/tests/suggestions `
  unity-shader-nav/tests/integration/client/signature-help.test.ts `
  docs/technical-spec.md `
  docs/usage.md `
  README.md `
  README.zh-CN.md `
  README.ja.md
git status --short
git commit -m "feat(issue-16): add shader function signature help"
```

Expected: one commit for issue #16 only.
