# Shader Completion Roadmap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to split this roadmap into issue-specific implementation plans before editing production code.

**Goal:** Add VS Code completion, signature help, and curated Unity/HLSL built-in vocabulary without weakening UnityShaderNav's current conservative navigation model.

**Architecture:** Build one shared suggestion model and context layer, then expose it through LSP completion and signature-help handlers. Project-index suggestions come first, signature help reuses the same function metadata, and built-ins plug into the same formatting/filtering pipeline later.

**Tech Stack:** TypeScript, VS Code Language Server Protocol, `vscode-languageserver`, `vscode-languageserver-textdocument`, Vitest, VS Code integration tests.

---

## Purpose

Issues #15, #16, and #17 should be implemented as three separate vertical slices, but they need one consistent direction:

- #15 creates the completion request path and project-index suggestion model.
- #16 adds signature help on top of the same function metadata and call-context helpers.
- #17 adds a curated built-in vocabulary as another suggestion/signature data source.

Do not implement #16 or #17 by creating separate symbol formatting, visibility, or function-signature logic. The main risk is three independently useful features growing three subtly different ideas of "what is visible here" and "how a shader function is described."

## Current Baseline

The server currently advertises only navigation and coloring capabilities in `unity-shader-nav/server/src/connection.ts`: definitions, document symbols, references, document highlights, and semantic tokens.

The server registers request handlers in `unity-shader-nav/server/src/server.ts`. There are no completion or signature-help handlers yet.

The index already stores useful data:

- `FunctionSymbolEntry.returnType`
- `FunctionSymbolEntry.parameters`
- `SymbolEntry.kind`
- `SymbolEntry.declaredType`
- `SymbolEntry.scopeRange`
- `SymbolEntry.parentType`

Existing navigation already has reusable concepts:

- `collectVisibleUriKeys` for include-visible file filtering.
- `resolveDefinitionSymbols` for same-file scoped shadowing and visible global candidates.
- `resolveMemberSymbols` for receiver-aware struct member lookup.
- `wordAt` and `memberAccessAt` for single-line identifier/member access detection.
- `isGenericDefinitionContext` for rejecting comments, strings, and ShaderLab regions outside HLSL blocks.

The technical spec currently lists "Formatting or completion" as a non-goal. #15 must change that wording once completion exists.

## Direction

Use a shared `suggestions` area rather than putting completion-specific logic directly inside handlers.

Recommended module shape:

- `server/src/suggestions/context.ts`
  - Classifies the request position.
  - Separates HLSL block, ShaderLab block, comment/string, member access, call expression, include path, and ordinary identifier contexts.
  - Starts conservative and single-line where the existing helpers are single-line.
  - Must not reuse `isGenericDefinitionContext` as the only gate. That helper correctly rejects ShaderLab regions for navigation, but #17 needs ShaderLab state completions outside HLSL blocks.
  - Suggested base context vocabulary: `hlslCode`, `shaderLabCode`, `comment`, `string`, `includePath`, `memberAccess`, and `call`.
  - #17 may extend this with coarse built-in-only contexts such as `semanticPosition` and `shaderLabStateValue` for safer filtering.
  - #15 should return no project-symbol suggestions for `shaderLabCode`; #17 can later populate that context with ShaderLab catalog entries.

- `server/src/suggestions/projectSymbols.ts`
  - Produces project-index suggestions from `FileIndex`, `GlobalSymbolIndex`, include visibility, and current position.
  - Reuses existing resolver behavior for scoped symbols and member access where possible.
  - Should add completion-specific enumeration helpers rather than relying on exact-name resolver APIs.
  - Suggested helper: `collectVisibleProjectSymbols(...)`, which walks same-file symbols plus `store.uris()` filtered by `collectVisibleUriKeys`.
  - Suggested ordering: locals/parameters first, same-file globals second, include-visible globals third, built-ins last once #17 exists.
  - Suggested dedupe: prefer the first candidate in that ordering for identical visible `name + kind + parentType` display groups, while preserving multiple function candidates when they represent real overload-like definitions.

- `server/src/suggestions/format.ts`
  - Converts internal suggestion records into LSP `CompletionItem` and `SignatureInformation`.
  - Owns label/detail/documentation formatting so #15, #16, and #17 stay visually consistent.

- `server/src/suggestions/callContext.ts`
  - Finds the current function call and active parameter for #16.
  - Should handle common single-line shader calls and nested parentheses conservatively.

- `server/src/suggestions/memberContext.ts`
  - Added in #15 if member completion is included there.
  - Provides completion-specific member enumeration such as `collectMemberSymbolsForReceiver(...)`.
  - Should extract or wrap receiver type inference from chain lookup instead of requiring a member name up front.

- `server/src/suggestions/builtins/`
  - Added in #17.
  - Contains curated catalog data and context filtering, not handler control flow.

Handlers should stay thin:

- `server/src/handlers/completion.ts` gets the document/workspace, reindexes open documents on store miss, builds suggestion context, and returns formatted completion items.
- `server/src/handlers/signatureHelp.ts` gets the document/workspace, builds call context, resolves function candidates from project symbols and later built-ins, and returns formatted signature help.

## Shared Data Contract

Introduce a small internal suggestion type before adding built-ins:

```ts
export type ShaderSuggestionSource = 'project' | 'builtin';

export interface ShaderParameter {
  name: string;
  type: string;
  documentation?: string;
}

export interface ShaderSuggestion {
  name: string;
  kind: SymbolKind | 'keyword' | 'semantic' | 'state' | 'function' | 'type';
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

This should be treated as a planning sketch, not a locked API. The important decision is that completion items and signature help both consume the same function metadata shape.

Do not expose `FunctionParameter` directly through the shared suggestion model. Indexed functions can map `FunctionParameter` to `ShaderParameter`, while built-ins can provide parameter metadata without fake source ranges.

## Issue #15: Project-Indexed Completion

Build the first completion slice with project symbols only.

Implementation boundaries:

- Add `completionProvider` to `createInitializeResult`.
- Register `registerCompletionHandler` in `server.ts`.
- Use `TextDocuments<TextDocument>`, `WorkspaceManager`, and optional `RequestSuspender` like the existing definition/references handlers.
- Reindex the open document on demand when the store misses, matching the definition handler pattern.
- Reject comments, strings, and non-HLSL ShaderLab regions.
- Return local/parameter suggestions only when the current position is inside their `scopeRange` and after their declaration.
- Return same-file globals and include-visible globals.
- For member access, prefer receiver-aware struct member suggestions over broad global suggestions.
- Add a completion-specific prefix/range helper. `wordAt` is definition-oriented and is not enough for normal completion positions such as whitespace, after `.`, or during partial identifier typing.
- Advertise `triggerCharacters: ['.']` at minimum.
- Support empty-prefix completion in valid HLSL code, partial identifier completion, `receiver.`, and `receiver.pa`.
- Include function detail from `returnType` and `parameters`.
- Do not add Unity/HLSL intrinsic vocabulary in this issue.
- Do not add snippets unless the behavior is tiny and covered by tests; simple labels/details are enough.

Testing boundaries:

- Add handshake tests for `completionProvider`.
- Add handler tests for same-file symbols, include-visible symbols, scoped locals/parameters, shadowing, member access, comments/strings rejection, and ShaderLab HLSL-block filtering.
- Add handler tests for partial identifier prefix, empty prefix, `receiver.`, `receiver.pa`, nested receiver shapes already supported by chain lookup, array receiver shapes, and unknown receiver fallback to an empty member result.
- Add at least one VS Code integration test using `vscode.executeCompletionItemProvider`.

Documentation:

- Update technical spec non-goals from "Formatting or completion" to something narrower, such as "Formatting and exhaustive compiler-grade completion."
- Mention that first completion support is project-index-backed and conservative.

## Issue #16: Indexed Function Signature Help

Build signature help after #15 so it can reuse suggestion formatting and function candidate collection.

Implementation boundaries:

- Add `signatureHelpProvider` to `createInitializeResult`.
- Register `registerSignatureHelpHandler` in `server.ts`.
- Trigger on `(` and `,`.
- Use `retriggerCharacters: [',']` if the LSP type shape supports it cleanly.
- Do not trigger on `)` unless a later failing test proves value; it risks stale or flickering help.
- Use `callContextAt(text, position)` to find:
  - callee name,
  - callee range,
  - argument list start,
  - active parameter index.
- Resolve project function candidates using the same visibility rules as #15.
- Represent ambiguous overload-like candidates as multiple signatures.
- Do not pretend to evaluate HLSL overload resolution or preprocessor conditions.
- Return `activeSignature` and `activeParameter` explicitly when a signature is returned.
- Return `null` when the call context is unclear, the callee is not known, or the position is outside code.

Testing boundaries:

- Unit-test call-context detection separately from LSP handler wiring.
- Cover active parameter calculation for first argument, later arguments, nested calls, empty argument lists, and comments/strings rejection.
- Add handler tests for same-file and include-visible project functions.
- Add a VS Code integration test using `vscode.executeSignatureHelpProvider`.

Documentation:

- Document that signature help is initially index-backed, conservative, and may show multiple candidates when Unity/preprocessor ambiguity exists.

## Issue #17: Curated Built-In Vocabulary

Build built-ins as an additional data source after #15 and #16.

Implementation boundaries:

- Add a catalog format that can describe:
  - HLSL intrinsic functions,
  - common Unity shader helper functions/macros,
  - common semantics,
  - common ShaderLab states and values.
- Require each entry to carry a source/category such as `hlsl`, `unitycg`, `urp`, `shaderlab`, or `semantic`.
- Do not add HDRP-specific entries until there is a fixture, documented need, or issue that justifies that vocabulary.
- Feed built-in entries through the same `ShaderSuggestion` and signature formatting code used by project symbols.
- Provide built-in signature help only when parameter metadata exists.
- Keep the initial catalog intentionally small and high-signal.
- Add context filtering before volume:
  - HLSL expressions get functions/types/macros/semantics where appropriate.
  - HLSL semantic positions get semantic suggestions.
  - ShaderLab regions outside HLSL blocks get ShaderLab state keywords.
  - ShaderLab state value positions get state values.
  - Comments and strings get nothing.
- Prefer catalog maintainability over exhaustive coverage.

Suggested first catalog:

- HLSL intrinsics: `float2`, `float3`, `float4`, `half`, `half2`, `half3`, `half4`, `normalize`, `dot`, `cross`, `lerp`, `saturate`, `mul`, `clamp`, `min`, `max`, `pow`, `sin`, `cos`, `tex2D`.
- Unity helpers/macros: `UnityObjectToClipPos`, `TRANSFORM_TEX`, `SAMPLE_TEXTURE2D`, `TEXTURE2D`, `SAMPLER`, `CBUFFER_START`, `CBUFFER_END`.
- Semantics: `POSITION`, `NORMAL`, `TANGENT`, `TEXCOORD0`, `TEXCOORD1`, `COLOR`, `SV_POSITION`, `SV_Target`, `SV_VertexID`, `SV_InstanceID`.
- ShaderLab states/values: `Blend`, `Cull`, `ZWrite`, `ZTest`, `Offset`, `ColorMask`, `Tags`, `LOD`, `Pass`, `SubShader`, `Off`, `On`, `Back`, `Front`, `Always`, `LEqual`, `Less`, `Greater`, `Equal`.

The exact catalog should be adjusted during #17, but the first pass should stay small enough to review by hand.

Testing boundaries:

- Unit-test catalog lookup and context filtering.
- Test that project suggestions and built-ins merge without duplicate spam.
- Test built-in signature help for at least one function with parameter metadata.
- Test ShaderLab state/value suggestions outside HLSL blocks, and no built-in suggestions inside ShaderLab strings/comments.
- Add or extend integration coverage if handler-level tests do not prove VS Code-visible behavior.

Documentation:

- Document that built-in vocabulary is curated and non-exhaustive.
- Add a short note on how to extend the catalog safely.

## Consistency Rules For The Three Future Plans

Each issue-specific plan should preserve these rules:

- Keep request handlers thin; put reusable logic under `server/src/suggestions/`.
- Use the same code path to format project and built-in function signatures.
- Use existing visibility/index rules before inventing new resolver behavior.
- Fail quietly and conservatively when context is ambiguous.
- Do not evaluate preprocessor conditions.
- Do not make #15 depend on the built-in catalog.
- Do not make #16 depend on built-in functions; built-ins can participate later through the shared interface.
- Do not create `codex/` branches; the repository explicitly forbids that prefix.
- Update docs only when the implemented issue changes user-visible behavior.

## Verification Baseline

For each implementation issue:

```powershell
cd unity-shader-nav
npm run build
npm run test -w @unity-shader-nav/server
```

Before merging user-visible behavior:

```powershell
cd unity-shader-nav
npm test
```

## Split Guidance

When this roadmap is split into executable plans:

- #15 plan should create the shared suggestion model, context classifier, completion handler, tests, and docs update.
- #16 plan should extend the shared model with call context and signature help, without changing #15 completion behavior except through shared formatting fixes.
- #17 plan should add the built-in catalog and merge/filtering behavior, without changing project-index completion or signature semantics except where needed to consume the new source.

Each issue should end with its own commit using the repository's conventional commit style, for example:

- `feat(issue-15): add project symbol completion`
- `feat(issue-16): add shader function signature help`
- `feat(issue-17): add built-in shader completion vocabulary`
