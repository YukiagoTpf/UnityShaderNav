# Plan02 Code Review Report

Review date: 2026-05-22

Scope:
- Plan document: `docs/superpowers/plans/2026-05-22-02-shaderlab-block-parser.md`
- Product commits: `302756b..a993b98`
- Reviewed code under `unity-shader-nav/shared/src/structure.ts`, `unity-shader-nav/server/src/parser/shaderlab/`, and `unity-shader-nav/tests/server/parser/shaderlab/`.

## Findings

### P1 - `scanStructure` counts braces inside strings as ShaderLab structure braces

References:
- `unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts:35`
- `unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts:51`
- `unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts:54`

`scanStructure` strips only `//` comments, then counts every `{` and `}` in the raw line. This makes a brace inside an HLSL or ShaderLab string close the current Shader/SubShader/Pass frame early.

Reproduced with this input:

```hlsl
Shader "X" {
  SubShader {
    Pass {
      HLSLPROGRAM
      const char* s = "}";
      ENDHLSL
    }
  }
}
```

Actual result:
- `pass.closeLine = 4`
- `subshader.closeLine = 6`
- `shader.closeLine = 7`

Expected:
- `pass.closeLine = 6`
- `subshader.closeLine = 7`
- `shader.closeLine = 8`

Impact: Plan10 Document Symbols will get incorrect ranges for otherwise valid shader files. Downstream features that use `ShaderLabStructureNode.closeLine` for containment checks can also mis-associate HLSL blocks with the wrong Pass/SubShader.

Recommended fix:
- Add a small line sanitizer/token scanner that ignores braces inside quoted strings and block/line comments before brace counting.
- Add regression tests for braces inside strings and block comments.

### P1 - Inline `Pass { Name "X" }` does not populate `ShaderLabStructureNode.name`

References:
- `unity-shader-nav/shared/src/structure.ts:20`
- `unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts:42`
- `unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts:45`
- `unity-shader-nav/tests/server/parser/shaderlab/structureScanner.test.ts:27`

The shared type comment explicitly documents `Pass { Name "X" } -> "X"`, but the implementation only checks `PASS_NAME_RE` in the final `else` branch. When a line starts with `Pass`, the `PASS_RE` branch opens the pass and skips name extraction for the same line.

Reproduced with:

```hlsl
Shader "X" {
  SubShader {
    Pass { Name "Inline" }
  }
}
```

Actual result: the pass node has no `name`.

Impact: Document Symbols and any pass-oriented UI will miss common compact ShaderLab pass names. Current tests only cover `Name` on the following line, so this regression is not protected.

Recommended fix:
- After opening a pass, scan the same line for `Name "..."`.
- Prefer a scanner that can find `Name` tokens inside the current Pass header/body line instead of requiring line-start `Name`.
- Add a fixture covering `Pass { Name "Inline" }`.

### P2 - `scanBlocks` does not handle `/* ... */` comments on directive lines

References:
- `unity-shader-nav/server/src/parser/shaderlab/blockScanner.ts:17`
- `unity-shader-nav/server/src/parser/shaderlab/blockScanner.ts:27`
- `unity-shader-nav/server/src/parser/shaderlab/blockScanner.ts:36`

`trimDirective` removes only `//` comments. Plan02 says the scanner should ignore comment syntax including `/* */`, but directive lines with trailing block comments are not recognized.

Reproduced with:

```hlsl
HLSLPROGRAM /* real block with trailing block comment */
void f() {}
ENDHLSL /* done */
```

Actual result: `scanBlocks` returns `blocks: []`.

Impact: Users who annotate HLSL block directives with block comments get no HLSL block ranges, which will block Plan03 symbol collection for that file.

Recommended fix:
- Strip same-line block comments before directive matching.
- If multiline block comments are in scope, carry comment state across lines; otherwise document that only same-line `/* ... */` comments are supported.
- Add tests for both `HLSLPROGRAM /* comment */` and `ENDHLSL /* comment */`.

### P2 - Structure scanner coverage is too thin for the advertised reusable output

References:
- `unity-shader-nav/tests/server/parser/shaderlab/structureScanner.test.ts:9`
- `unity-shader-nav/tests/server/parser/shaderlab/structureScanner.test.ts:27`

The structure scanner is intended to be reused by Plan10 Document Symbols, but current tests only verify a simple tree shape and next-line pass names. They do not assert `headerLine`/`closeLine`, inline pass names, comments/strings, multiple SubShaders, or malformed/unterminated structures.

Impact: The most important part of the structure result, stable ranges, can regress while tests stay green. This is already visible in the string-brace case above.

Recommended fix:
- Add focused assertions for `headerLine` and `closeLine` in the existing fixtures.
- Add fixtures for inline pass names, multiple SubShaders, block comments, string braces, and unterminated braces.

## Verification

Commands run from `unity-shader-nav/`:

```bash
npm test
```

Result:
- Passed.
- test-electron activation: 1 passing.
- vitest: 4 files, 12 tests passing.

Additional read-only probes were run against compiled `server/out/parser/shaderlab/*` to reproduce the three findings above.

## Summary

Plan02 provides a small and useful parser foundation, and the existing happy-path block scanner tests pass. The main risk is in `scanStructure`: it is already returning incorrect ranges for strings with braces, and it misses the inline pass-name shape documented in the shared type. Before Plan10 depends on this structure output, the scanner needs a minimal comment/string-aware tokenizer and stronger range-oriented tests.
