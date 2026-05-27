# Issue 14 ShaderLab Highlighting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement issue 14 by giving mixed `.shader` files stable ShaderLab, Properties, Tags, preprocessor, and Unity/HLSL semantic-token highlighting without regressing navigation.

**Architecture:** Keep the existing tree-sitter HLSL index as the source of project-symbol semantic tokens, and add a small lexical token scanner for ShaderLab wrapper syntax plus preprocessor syntax. Compose lexical tokens with existing index-derived semantic tokens in the semantic token handler, preferring index-derived symbols when ranges overlap.

**Tech Stack:** TypeScript, VS Code LSP semantic tokens, `vscode-languageserver`, existing `tree-sitter-hlsl` parser, Vitest, VS Code integration tests.

---

## Current Support Check

Issue 14 is not fully supported today.

Evidence:

- `unity-shader-nav/client/package.json` contributes `shaderlab` and `hlsl` languages, but does not contribute TextMate grammars or embedded language mappings.
- `unity-shader-nav/server/src/handlers/semanticTokens.ts` only exposes `type`, `variable`, `parameter`, `property`, `function`, and `macro`.
- The semantic token handler builds tokens only from `FileIndex.symbols` and `FileIndex.references`.
- `unity-shader-nav/server/src/parser/hlsl/fileIndexer.ts` indexes only HLSL/CG block contents for `.shader` files, then attaches ShaderLab structure for document symbols.
- Current semantic token tests cover HLSL symbols and macros, but do not assert ShaderLab `Properties`, `Tags`, render-state directives, ShaderLab attributes, property values, or preprocessor directive token coverage.

Existing partial support should be reused rather than duplicated:

- ShaderLab state names, state values, HLSL built-ins, Unity/URP macros, and shader semantics already exist in the completion catalog at `unity-shader-nav/server/src/suggestions/builtins/catalog.ts`.
- `#include`, `#define`, and `#pragma` lines are already scanned for navigation/indexing inside HLSL blocks.
- Built-in declaration macros such as `TEXTURE2D($name)`, `SAMPLER($name)`, and `CBUFFER_START($name)` already exist in `unity-shader-nav/server/src/macros/builtin.ts`.
- ShaderLab structure already feeds document symbols.

The existing feature set partially covers HLSL block symbols inside `.shader` files, but misses the visible ShaderLab wrapper syntax and highlight-only built-in/semantic token coverage required by issue 14.

## Execution Notes

- Run all `npm` commands from `unity-shader-nav/`, the monorepo package root.
- Keep Git work on the current branch unless the operator explicitly creates a branch. Project policy forbids `codex/` branch prefixes.
- Commit after each completed task with the exact conventional commit style shown below.

## Design Choices

Use semantic tokens rather than a first-pass TextMate grammar for the issue 14 slice.

Reasons:

- The extension already owns an LSP semantic token path and can test it directly.
- A narrow lexical scanner can reuse the existing ShaderLab block scanner to avoid HLSL/navigation regressions.
- This avoids introducing a second grammar technology while still meeting "grammar or semantic-token support where appropriate" from the issue.

Known limitation:

- Token colors remain theme-dependent. Documentation should call out that themes with semantic highlighting disabled or sparse semantic token rules may show less visible differentiation.
- There will be no TextMate fallback in this plan. Highlighting appears after the language server is active and the document is indexed.

## Token Model

Expand `SEMANTIC_TOKEN_TYPES` in `unity-shader-nav/server/src/handlers/semanticTokens.ts` to include VS Code standard token types:

```ts
export const SEMANTIC_TOKEN_TYPES = [
  'type',
  'variable',
  'parameter',
  'property',
  'function',
  'macro',
  'keyword',
  'string',
  'number',
  'operator',
  'decorator',
  'enumMember',
] as const;
```

Recommended token mapping:

| Source syntax | Token type |
| --- | --- |
| `Shader`, `Properties`, `SubShader`, `Pass`, `Tags`, `HLSLPROGRAM`, `ENDHLSL`, `CGPROGRAM`, `ENDCG`, `HLSLINCLUDE`, `ENDHLSL`, `CGINCLUDE` | `keyword` |
| Render-state names such as `Blend`, `Cull`, `ZWrite`, `ZTest`, `Name`, `LOD` | `keyword` |
| Property identifiers such as `_BaseMap` | `property` |
| Property display strings and tag values | `string` |
| Property types such as `2D`, `Color`, `Range`, `Vector`, `Float`, `Int`, `Cube`, `3D` | `type` |
| Property attributes such as `[Header]`, `[Space]`, `[NoScaleOffset]` | `decorator` |
| Numeric literals and tuple numeric values | `number` |
| Tag keys such as `LightMode`, `Queue`, `RenderType` | `property` |
| Preprocessor directive names such as `#include`, `#pragma`, `#define` | `keyword` |
| Include paths | `string` |
| Macro definition names and macro-style declaration heads such as `TEXTURE2D`, `SAMPLER`, `CBUFFER_START` | `macro` |
| Shader semantics such as `POSITION`, `TEXCOORD0`, `SV_POSITION`, `SV_Target` | `enumMember` |

## Implementation Tasks

### Task 1: Add Failing ShaderLab Semantic Token Coverage

**Files:**

- Modify: `unity-shader-nav/server/tests/handlers/semanticTokens.test.ts`

**Step 1: Add helper for token text assertions**

Add a helper near `decodeTokens` so tests can assert by source text instead of only positions:

```ts
function tokenTexts(
  text: string,
  tokens: Array<{ line: number; character: number; length: number; type: string }>,
): Array<{ text: string; type: string }> {
  const lines = text.split(/\r?\n/);
  return tokens.map((token) => ({
    text: lines[token.line].slice(token.character, token.character + token.length),
    type: token.type,
  }));
}
```

**Step 2: Add failing mixed ShaderLab test**

Add a test that creates a `.shader` document and asserts the issue 14 acceptance tokens:

```ts
import { MacroPatternTable } from '../../src/macros';

it('colors ShaderLab wrapper syntax, properties, tags, preprocessor, and HLSL symbols', async () => {
  const { connection, handler } = captureSemanticTokensHandler();
  const uri = 'file:///project/Assets/Mixed.shader';
  const text = [
    'Shader "Custom/Mixed" {',
    '  Properties {',
    '    [Header(Main)] [Space]',
    '    _BaseMap ("Base Map", 2D) = "white" {}',
    '    _Tint ("Tint", Color) = (1, 0.5, 0, 1)',
    '    _Roughness ("Roughness", Range(0, 1)) = 0.5',
    '  }',
    '  SubShader {',
    '    Tags { "LightMode"="UniversalForward" "RenderType"="Opaque" }',
    '    LOD 100',
    '    Pass {',
    '      Name "Forward"',
    '      Cull Back',
    '      ZWrite On',
    '      HLSLPROGRAM',
    '      #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
    '      #pragma vertex vert',
    '      #define SAMPLE_ALBEDO(tex, uv) tex.Sample(sampler##tex, uv)',
    '      TEXTURE2D(_BaseMap);',
    '      SAMPLER(sampler_BaseMap);',
    '      CBUFFER_START(UnityPerMaterial)',
    '      float4 _Tint;',
    '      CBUFFER_END',
    '      struct Attributes { float3 positionOS : POSITION; };',
    '      float4 vert(Attributes input) : SV_POSITION { return float4(input.positionOS, 1); }',
    '      ENDHLSL',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const doc = TextDocument.create(uri, 'shaderlab', 1, text);
  const index = await indexFile(uri, text, new MacroPatternTable());
  const store = new IndexStore();
  store.set(uri, index);
  const global = new GlobalSymbolIndex();
  const globalRefs = new GlobalReferenceIndex();
  global.upsert(index);
  globalRefs.upsert(index);
  const documents = { get: (requestedUri: string) => requestedUri === uri ? doc : undefined } as never;
  const workspace = { store, global, globalRefs };
  const manager = {
    async workspaceForOrCreateFile(requestedUri: string) {
      return requestedUri === uri ? workspace : undefined;
    },
  } as never;

  registerSemanticTokensHandler(connection, documents, manager);

  const tokens = decodeTokens(await handler()({ textDocument: { uri } }));
  expectSortedAndNonOverlapping(tokens);
  expect(tokenTexts(text, tokens)).toEqual(expect.arrayContaining([
    { text: 'Shader', type: 'keyword' },
    { text: 'Properties', type: 'keyword' },
    { text: 'Header', type: 'decorator' },
    { text: '_BaseMap', type: 'property' },
    { text: 'Base Map', type: 'string' },
    { text: '2D', type: 'type' },
    { text: 'Color', type: 'type' },
    { text: 'Range', type: 'type' },
    { text: 'LightMode', type: 'property' },
    { text: 'UniversalForward', type: 'string' },
    { text: 'LOD', type: 'keyword' },
    { text: 'Cull', type: 'keyword' },
    { text: 'ZWrite', type: 'keyword' },
    { text: 'HLSLPROGRAM', type: 'keyword' },
    { text: '#include', type: 'keyword' },
    { text: 'Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl', type: 'string' },
    { text: '#pragma', type: 'keyword' },
    { text: 'vert', type: 'function' },
    { text: 'SAMPLE_ALBEDO', type: 'macro' },
    { text: 'TEXTURE2D', type: 'macro' },
    { text: 'SAMPLER', type: 'macro' },
    { text: 'CBUFFER_START', type: 'macro' },
    { text: 'UnityPerMaterial', type: 'variable' },
    { text: 'Attributes', type: 'type' },
    { text: 'POSITION', type: 'enumMember' },
    { text: 'SV_POSITION', type: 'enumMember' },
    { text: 'positionOS', type: 'property' },
    { text: 'ENDHLSL', type: 'keyword' },
  ]));
});
```

**Step 3: Run the focused test and confirm it fails**

Run:

```bash
npm run build --workspace @unity-shader-nav/shared
npm run test --workspace @unity-shader-nav/server -- server/tests/handlers/semanticTokens.test.ts
```

Expected:

- The new test fails because `keyword`, `string`, `number`, `decorator`, `enumMember`, ShaderLab property entries, tag tokens, pragma entry tokens, and macro-style declaration heads are not fully emitted.

**Step 4: Commit**

```bash
git add unity-shader-nav/server/tests/handlers/semanticTokens.test.ts
git commit -m "test(issue-14): cover ShaderLab semantic highlighting"
```

### Task 2: Add ShaderLab Lexical Token Scanner

**Files:**

- Create: `unity-shader-nav/server/src/parser/shaderlab/tokenScanner.ts`
- Test: `unity-shader-nav/server/tests/parser/shaderlab/tokenScanner.test.ts`

**Step 1: Define scanner token types**

Create an internal token model that matches the semantic handler's token type names:

```ts
import type { Range } from '@unity-shader-nav/shared';

export type ShaderLabLexicalTokenType =
  | 'keyword'
  | 'property'
  | 'string'
  | 'type'
  | 'decorator'
  | 'number'
  | 'macro'
  | 'enumMember';

export interface ShaderLabLexicalToken {
  range: Range;
  tokenType: ShaderLabLexicalTokenType;
}
```

**Step 2: Implement line-oriented scanning**

Implement a conservative scanner with these rules:

- Strip `//` comments and block-comment spans before token matching.
- Track whether the current line is in a `Properties` block by brace depth.
- Track whether the current line is a `Tags { ... }` line or inside a multiline `Tags` block.
- Use `scanBlocks(text)` to identify HLSL/CG block line ranges.
- For all lines, emit block delimiter keywords such as `HLSLPROGRAM` and `ENDHLSL`.
- Outside HLSL/CG blocks, emit ShaderLab container/render-state tokens.
- Inside HLSL/CG blocks, emit only highlight-only lexical gaps: preprocessor directive tokens, include paths, macro definition names, built-in macro declaration heads, shader semantics, and swizzles. Existing index-derived HLSL symbols remain authoritative for project symbols.
- Reuse existing catalog/macro knowledge where practical instead of hardcoding a second divergent list. Good sources are `BUILTIN_ENTRIES` for built-in/semantic names and `BUILTIN_DECLARATION_MACROS` for macro-style declaration heads.

Recommended constants:

```ts
import { BUILTIN_DECLARATION_MACROS } from '../../macros/builtin';
import { BUILTIN_ENTRIES } from '../../suggestions/builtins/catalog';

const SHADERLAB_KEYWORDS = new Set([
  'Shader',
  'Properties',
  'SubShader',
  'Pass',
  'Tags',
  'Name',
  'LOD',
  'Blend',
  'Cull',
  'ZWrite',
  'ZTest',
  'Offset',
  'ColorMask',
  'Stencil',
  'HLSLPROGRAM',
  'ENDHLSL',
  'CGPROGRAM',
  'ENDCG',
  'HLSLINCLUDE',
  'CGINCLUDE',
]);

const PROPERTY_TYPES = new Set([
  '2D',
  '3D',
  'Cube',
  'Color',
  'Vector',
  'Float',
  'Range',
  'Int',
]);

const HLSL_SEMANTICS = new Set(
  BUILTIN_ENTRIES
    .filter((entry) => entry.kind === 'semantic')
    .map((entry) => entry.name),
);

const DECLARATION_MACRO_HEADS = new Set(
  BUILTIN_DECLARATION_MACROS.map((entry) => entry.pattern.split('(')[0]),
);
```

**Step 3: Add scanner unit tests**

Cover at least:

- ShaderLab keywords and render states.
- Properties identifiers, strings, attributes, types, and numbers.
- Tags keys and values.
- HLSL block delimiters.
- Preprocessor directives inside HLSL blocks, including `#pragma vertex vert` where `#pragma` is `keyword` and `vert` is left for the index-derived `function` token.
- Include paths as `string`.
- Built-in macro declaration heads such as `TEXTURE2D`, `SAMPLER`, and `CBUFFER_START` as `macro`.
- Shader semantics such as `POSITION` and `SV_POSITION` as `enumMember`.
- Commented-out ShaderLab or preprocessor syntax does not emit tokens.

Run:

```bash
npm run test --workspace @unity-shader-nav/server -- server/tests/parser/shaderlab/tokenScanner.test.ts
```

Expected:

- New scanner tests pass.
- The semantic token handler test from Task 1 still fails until composition is wired.

**Step 4: Commit**

```bash
git add unity-shader-nav/server/src/parser/shaderlab/tokenScanner.ts unity-shader-nav/server/tests/parser/shaderlab/tokenScanner.test.ts
git commit -m "feat(issue-14): scan ShaderLab lexical highlight tokens"
```

### Task 3: Compose Lexical Tokens With Existing Semantic Tokens

**Files:**

- Modify: `unity-shader-nav/server/src/handlers/semanticTokens.ts`

**Step 1: Expand semantic token legend**

Add the token types from the Token Model section.

**Step 2: Pass document text into token building**

Change `semanticTokensForIndex` to accept an optional text payload:

```ts
function semanticTokensForIndex(
  index: FileIndex,
  global?: SymbolLookup,
  text?: string,
): SemanticTokens {
  // existing symbol/reference tokens
}
```

In `registerSemanticTokensHandler`, fetch the open document before building tokens:

```ts
const document = documents.get(params.textDocument.uri);
return semanticTokensForIndex(index, workspace.global, document?.getText());
```

**Step 3: Add lexical tokens for `.shader` documents**

Import `scanShaderLabTokens` and merge tokens before sorting:

```ts
if (text && /\.shader(?:$|[?#])/i.test(index.uri)) {
  for (const token of scanShaderLabTokens(text)) {
    tokens.push(token);
  }
}
```

**Step 4: Keep overlap handling deterministic**

Replace exact-range de-duplication with overlap-aware de-duplication after sorting by start range and priority.

Desired rule:

- Index-derived project tokens win over lexical fallback tokens for identical or overlapping ranges.
- Lexical syntax tokens fill the gaps around project symbols.
- Same-line overlapping tokens are skipped instead of emitted because LSP semantic tokens cannot overlap.

Add a source marker:

```ts
interface TokenRange {
  range: Range;
  tokenType: SemanticTokenType;
  source?: 'index' | 'lexical';
}
```

Use source priority before token type priority:

```ts
const SOURCE_PRIORITY = {
  index: 0,
  lexical: 1,
} as const;
```

**Step 5: Run focused tests**

Run:

```bash
npm run test --workspace @unity-shader-nav/server -- server/tests/handlers/semanticTokens.test.ts
```

Expected:

- Existing HLSL semantic token test passes.
- New mixed ShaderLab semantic token test passes.

**Step 6: Commit**

```bash
git add unity-shader-nav/server/src/handlers/semanticTokens.ts
git commit -m "feat(issue-14): emit ShaderLab semantic highlight tokens"
```

### Task 4: Improve HLSL Built-in, Semantic, Macro, And Swizzle Highlighting

**Files:**

- Modify: `unity-shader-nav/server/src/handlers/semanticTokens.ts`
- Modify: `unity-shader-nav/server/src/parser/shaderlab/tokenScanner.ts`
- Modify: `unity-shader-nav/server/src/suggestions/builtins/catalog.ts` only if the existing catalog lacks required names.
- Modify: `unity-shader-nav/server/tests/handlers/semanticTokens.test.ts`

**Step 1: Add focused expectations**

Extend the semantic token tests to cover:

- Unity/HLSL built-in types such as `float4`, `Texture2D`, and `SamplerState` as `type` where the parser exposes them as type nodes or references.
- Shader semantics such as `POSITION`, `TEXCOORD0`, `SV_POSITION`, and `SV_Target` as `enumMember`.
- Function calls such as `TransformObjectToHClip(...)` as `function`.
- Macro-style declaration heads such as `TEXTURE2D`, `SAMPLER`, and `CBUFFER_START` as `macro`.
- Member access such as `input.positionOS` as `property`.
- Swizzles such as `.xy` or `.rgba` as `property`.
- Captured macro declaration names such as `_BaseMap`, `sampler_BaseMap`, and `UnityPerMaterial` still appear from the existing macro index path when indexed with `new MacroPatternTable()`.

**Step 2: Implement only scanner-backed gaps**

Use `BUILTIN_ENTRIES` as the source for highlight-only built-ins and shader semantics. Map `entry.kind` to semantic token types:

- `type` -> `type`
- `function` -> `function`
- `macro` -> `macro`
- `semantic` -> `enumMember`

If tree-sitter already creates `field_expression` nodes for swizzles, existing `member` reference handling may already emit `property`. If not, add a narrow lexical fallback for dot-swizzle patterns inside HLSL block text:

```ts
const SWIZZLE_RE = /\.(?:[xyzw]{1,4}|[rgba]{1,4})\b/g;
```

Keep this fallback local to semantic highlighting. Do not feed swizzle names into the symbol index, definitions, or references.

**Step 3: Keep macro declaration behavior index-compatible**

Macro-style declarations already have navigation behavior through `MacroPatternTable`. The highlighting implementation should:

- Tokenize the macro head (`TEXTURE2D`, `SAMPLER`, `CBUFFER_START`) as highlight-only `macro`.
- Leave captured declaration names (`_BaseMap`, `sampler_BaseMap`, `UnityPerMaterial`) to the existing index-derived symbol path.
- Avoid adding macro heads or shader semantics to `FileIndex.symbols` or `FileIndex.references` unless they are already real references.

**Step 4: Avoid built-in symbol pollution**

Do not add built-in types or intrinsics as project symbols. Highlight them as lexical or reference-derived semantic tokens only.

**Step 5: Run focused tests**

Run:

```bash
npm run test --workspace @unity-shader-nav/server -- server/tests/handlers/semanticTokens.test.ts
```

Expected:

- Built-in and swizzle cases pass without changing definition/reference behavior.

**Step 6: Commit**

```bash
git add unity-shader-nav/server/src/handlers/semanticTokens.ts unity-shader-nav/server/src/parser/shaderlab/tokenScanner.ts unity-shader-nav/server/tests/handlers/semanticTokens.test.ts
git commit -m "feat(issue-14): highlight HLSL built-ins semantics and swizzles"
```

### Task 5: Add Client-Level Integration Coverage

**Files:**

- Modify: `unity-shader-nav/tests/integration/client/document-highlight.test.ts` only if semantic token requests fit existing integration harness patterns.
- Otherwise create: `unity-shader-nav/tests/integration/client/semantic-tokens.test.ts`
- Create fixture if useful: `unity-shader-nav/tests/integration/client/fixtures/highlighting/Mixed.shader`

**Step 1: Add fixture**

Use the same mixed ShaderLab + HLSL example from Task 1 as the integration fixture.

**Step 2: Request semantic tokens through VS Code API**

Use VS Code's command/API path for document semantic tokens if available in the current test harness:

```ts
const tokens = await vscode.commands.executeCommand(
  'vscode.provideDocumentSemanticTokens',
  document.uri,
);
```

If the API is not available in this VS Code version or test setup, keep this as a server-level tested feature and document the reason in the issue summary.

**Step 3: Run integration tests**

Run the full integration path because the root script chains build, package-layout tests, Electron tests, and workspace tests; `--grep` is not reliable through that wrapper.

```bash
npm test
```

Expected:

- Integration coverage confirms semantic tokens are served for an activated `.shader` file.

**Step 4: Commit**

```bash
git add unity-shader-nav/tests/integration/client/semantic-tokens.test.ts unity-shader-nav/tests/integration/client/fixtures/highlighting/Mixed.shader
git commit -m "test(issue-14): verify shader semantic tokens in extension host"
```

### Task 6: Update Documentation And Changelog

**Files:**

- Modify: `README.md`
- Modify: `docs/usage.md`
- Modify: `docs/technical-spec.md`
- Modify: `CHANGELOG.md`

**Step 1: Update user-facing feature wording**

Mention that `.shader` highlighting now covers:

- ShaderLab block keywords.
- Properties and Tags blocks.
- Render-state directives.
- HLSL preprocessor directives and include paths.
- Existing HLSL symbols, functions, macros, macro-style declarations, shader semantics, members, and swizzles.

**Step 2: Add limitation note**

Add a short note to `docs/usage.md`:

```md
Semantic coloring depends on the active VS Code theme. Themes with semantic
highlighting disabled or sparse semantic token rules may show less visible
separation between token categories.
```

**Step 3: Update changelog**

Add an Unreleased bullet:

```md
- Improved ShaderLab and Unity HLSL highlighting for `.shader` files, including
  Properties, Tags, render states, preprocessor lines, built-ins, and swizzles.
```

**Step 4: Run docs-adjacent checks**

Run:

```bash
npm run build
```

Expected:

- TypeScript build passes.

**Step 5: Commit**

```bash
git add README.md docs/usage.md docs/technical-spec.md CHANGELOG.md
git commit -m "docs(issue-14): document shader highlighting improvements"
```

### Task 7: Full Verification And Issue Summary

**Files:**

- No planned code changes.
- Optional GitHub issue comment on issue 14 with implementation and verification summary.

**Step 1: Run full verification**

Run from `unity-shader-nav/`:

```bash
npm run build
npm test
```

Expected:

- Build passes.
- Full test suite passes.

**Step 2: Manually smoke-test in VS Code**

Open `unity-shader-nav/` in VS Code, press F5, and open a mixed `.shader` file.

Check:

- ShaderLab keywords and render states are visibly highlighted.
- Properties and Tags are readable.
- HLSL block symbols retain previous semantic colors.
- F12, Find References, Outline, Document Highlight, Completion, and Signature Help still work on representative samples.

**Step 3: Post issue summary**

Post a concise issue comment:

```md
Implemented issue 14.

Verification:
- npm run build
- npm test
- Manual VS Code smoke test on mixed ShaderLab + HLSL fixture

Notes:
- Highlight colors are theme-dependent because VS Code semantic token styling is theme-driven.
```

**Step 4: Commit only if issue summary changes repo docs**

No commit is needed for a GitHub-only issue comment.

## Regression Risks

- Overlapping semantic tokens can produce invalid or dropped LSP token streams. Keep overlap tests strict.
- Lexical scanning can accidentally color commented-out syntax. Scanner tests must cover line and block comments.
- ShaderLab block depth can be disturbed by braces inside strings. Reuse the existing ShaderLab sanitizer/block scanner patterns where possible.
- Adding built-in names to the symbol index would affect navigation. Keep highlight-only built-ins out of definition/reference indices.
- Themes vary. Do not promise exact colors, only stable token categories.

## Completion Criteria

- Issue 14 acceptance criteria are represented in tests.
- Existing HLSL semantic token tests still pass.
- `.shader` outer syntax emits semantic tokens for ShaderLab wrapper constructs.
- HLSL block navigation behavior is unchanged.
- Docs and changelog mention the visible highlighting improvement and theme limitations.
- Full `npm test` passes from `unity-shader-nav/`.
