# Technical Spec

This document describes the current UnityShaderNav product and implementation
shape. It is not an implementation plan; detailed issue work belongs in GitHub
Issues and git history.

## Goals

UnityShaderNav provides practical VS Code navigation for Unity shader projects:

- Go to Definition for ShaderLab/HLSL symbols.
- Find References for project-authored shader code.
- Conservative completion and signature help for project-indexed symbols in
  HLSL/CG code.
- Document Symbols for fast file outline navigation.
- Document Highlight and semantic coloring for common shader symbols.
- Cross-file navigation through `#include` chains and resolved Unity Packages.

The project optimizes for useful editor behavior over full shader compilation
semantics.

## Non-Goals

- Shader compilation, preview, or diagnostics.
- Formatting or exhaustive compiler-grade completion.
- Full C preprocessor expansion.
- Rider-style shader context selection.
- ShaderGraph generated-code modeling.
- C# to shader cross-language navigation.
- Surface Shader implicit parameter synthesis.

## Supported Inputs

| Extension | Notes |
|---|---|
| `.shader` | ShaderLab wrapper plus embedded `HLSLPROGRAM` / `CGPROGRAM` blocks |
| `.hlsl` | HLSL files and include files |
| `.cginc` | Unity CG includes, with pragmatic legacy declaration support |
| `.hlslinc` | HLSL include files |
| `.compute` | Compute shader files, including `#pragma kernel` references |

## High-Level Architecture

```text
VS Code extension client
  - contributes languages and settings
  - starts the language server
  - exposes status/output integration

Language server
  - detects Unity project roots
  - scans user files and resolved package files
  - parses ShaderLab blocks and HLSL syntax
  - builds symbol/reference indexes
  - answers LSP definition, references, symbols, highlight, and semantic-token requests
  - persists cache under Library/UnityShaderNavCache
```

See [Architecture](architecture.md) for module-level details.

## Project Root Detection

A Unity project root is a directory containing both:

- `Assets/`
- `ProjectSettings/`

When no root is found, the server enters standalone mode. Same-file navigation
still works, but package and include-chain navigation are disabled.

Users can override detection with `unityShaderNav.projectRoot`.

## Indexing Scope

The server indexes:

- User shader files under the workspace or detected Unity project root.
- Unity package files resolved from `Packages/packages-lock.json`.
- Extra include directories configured through `unityShaderNav.includeDirectories`.

User-file scanning respects `unityShaderNav.excludePatterns`. Package indexing
does not use those globs; packages are selected from the Unity lock file.

## Symbol Model

The index stores multiple candidates per name. This is deliberate because Unity
shader code often contains:

- Multiple preprocessor branches.
- Multiple ShaderLab passes with the same `vert` / `frag` entry names.
- HLSL overload-like definitions.
- Package and project functions sharing names.

The resolver prefers local and include-visible targets when possible. When more
than one target remains valid, the server returns all candidates and lets VS Code
show Peek Definition.

Completion uses the same project index and include visibility rules. It suggests
project functions, variables, parameters, structs, macros, and receiver-aware
struct members in HLSL/CG code, but it intentionally avoids exhaustive Unity or
HLSL built-in vocabulary.

Signature help is also project-index-backed and conservative. It shows indexed
project function signatures for visible free-function calls and may return
multiple candidates when preprocessor or overload-like ambiguity exists. Built-in
Unity/HLSL function signatures are intentionally not promised by this layer.

## Scope and Visibility

The server tracks enough scope to resolve common navigation cases:

- Function parameters.
- Local variables.
- File globals.
- Struct declarations and members.
- Include-chain visibility.
- Unity Package visibility through resolved package files.

Find References uses canonical target identity (`uri`, `range`, and kind) to
avoid mixing unrelated same-name symbols.

## Chain Lookup

Struct member navigation is receiver-aware. Supported shapes include:

- Parameter receivers, such as `i.positionWS`.
- Local/global struct receivers, such as `inputData.positionWS`.
- Array element receivers, such as `lights[i].color`.
- Nested fields, such as `surface.brdfData.roughness`.
- Cbuffer/global struct values.
- Narrow RHS call assignment inference, such as `surface = MakeSurface();`
  followed by `surface.positionWS`, only when the visible function candidate is
  unambiguous.

Unsupported shapes intentionally fail conservatively:

- Multiline receiver expressions.
- Macro-expanded receivers.
- Ternary or branch-dependent receiver types.
- Overload-aware return type selection.
- Pointer/reference-like syntax outside ordinary Unity HLSL member access.

## Macro Handling

The server does not expand macro bodies. Instead, it recognizes stable Unity
declaration and reference patterns:

- Texture/sampler/cbuffer declaration macros.
- Unity instancing property declarations.
- `#pragma vertex`, `#pragma fragment`, `#pragma geometry`, `#pragma hull`,
  `#pragma domain`, and `#pragma kernel` entry references.
- `#define` macro declarations.

Projects can add custom declaration patterns with
`unityShaderNav.declarationMacros`.

## Include and Package Resolution

Include resolution checks:

1. The including file's directory.
2. The Unity project `Assets/` root.
3. Resolved Unity package physical paths.
4. User-configured include directories.

`Packages/<name>/...` paths are mapped through `Packages/packages-lock.json`.
This avoids scanning stale package cache folders and follows Unity's resolved
dependency state.

## Cache

The cache is persisted under:

```text
<UnityProject>/Library/UnityShaderNavCache/
```

Cache records are versioned and fingerprinted. Incompatible or stale cache data
is discarded and rebuilt. Standalone mode falls back to VS Code global storage.

## Public Settings

See [Configuration](configuration.md) for details.

| Setting | Purpose |
|---|---|
| `unityShaderNav.projectRoot` | Explicit Unity project root |
| `unityShaderNav.includeDirectories` | Extra include search roots |
| `unityShaderNav.excludePatterns` | User-file scan excludes |
| `unityShaderNav.declarationMacros` | Project-specific declaration macro patterns |
| `unityShaderNav.findReferences.includePackages` | Include package references in Shift+F12 |
| `unityShaderNav.debug.definitionTrace` | Debug definition resolution |

## Verification Baseline

Core verification commands:

```powershell
cd unity-shader-nav
npm run build
npm run test -w @unity-shader-nav/server
npm test
```

Use focused server tests for parser/resolver changes, then run broader tests
before publishing or merging user-visible behavior changes.
