# Changelog

All notable changes to UnityShaderNav are recorded here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/)
and uses semantic versioning for extension releases once public publishing starts.

## Unreleased

### Added

- Conservative preprocessor branch dimming: inactive and variant-dependent
  `#if`/`#ifdef`/`#ifndef` branches in shader/HLSL files are visually dimmed via
  client decorations. This is presentation-only and does not change navigation,
  references, or completion. Configurable through
  `unityShaderNav.dimInactiveBranches.enabled` and `.opacity`. See
  [ADR-0005](docs/adr/0005-conservative-preprocessor-branch-dimming.md).
- Hover information for indexed shader symbols (functions, structs, members,
  variables, parameters, macros, selected built-ins). Hover shows a
  declaration-style summary and source location, reusing the same local-scope
  and include-visibility rules as Go to Definition. Ambiguous symbols are
  rendered as stacked candidates without picking a winner.

## 0.0.6 - 2026-05-27

### Added

- Improved ShaderLab and Unity HLSL semantic coloring for `.shader` files,
  including Properties, Tags, render states, preprocessor lines, macro-style
  declarations, shader semantics, built-ins, members, and swizzles.

## 0.0.5 - 2026-05-27

### Added

- Project-index-backed completion for shader symbols, including functions,
  globals, locals, parameters, structs, struct members, macros, and
  include-visible symbols.
- Signature help for indexed shader functions, with conservative active
  parameter detection and multiple candidates when ambiguity remains.
- A curated Unity/HLSL/ShaderLab built-in vocabulary for completion, plus
  built-in function signatures where catalog metadata is available.
- Public project documentation for users and contributors.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, and open-source-oriented docs
  under `docs/`.
- GitHub issue and pull request templates.

### Changed

- Completion and signature help are now documented as supported conservative
  editor features rather than future work.
- Removed historical implementation plans and local agent progress logs from the
  tracked documentation tree. Git history and GitHub Issues remain the source of
  record for old execution details.
- Moved the original technical specification to `docs/technical-spec.md`.

## 0.0.4 - 2026-05-26

### Added

- VS Code Marketplace icon asset and packaging metadata.

## 0.0.3 - 2026-05-25

### Added

- Document Highlight and semantic token support for ShaderLab/HLSL symbols.
- Struct member highlighting and conservative receiver-aware fallback behavior.
- Chain lookup support for array receivers, nested fields, cbuffer/global struct
  values, and narrow same-scope RHS call-return inference.
- Benchmark command for index/cache performance profiling.
- Bounded concurrency for shader file walking, cache restore, workspace indexing,
  and cache persistence.

### Fixed

- Include-chain definition and Find References filtering now prefer visible,
  canonical targets instead of name-only project-wide matches.
- Struct type identifiers and receiver-typed struct members resolve through
  same-file and include-visible definitions.
- Unity structural macro sentinels such as `CBUFFER_END` and instancing buffer
  sentinels no longer pollute ordinary references.
- Cache persistence preserves the previous manifest if final replacement fails.
- Legacy CG variable declarations such as `sampler2D`, `fixed4`, and `half`
  have regression coverage.

### Notes

- Several fixes were first tracked through local implementation plans. Their
  final diagnosis, verification, and commit lists have been copied into the
  corresponding GitHub issues.

## 0.0.1 - 2026-05-22

### Added

- Initial monorepo structure for the VS Code client, language server, and shared
  protocol/types package.
- ShaderLab block parsing and HLSL symbol collection.
- Go to Definition, include path navigation, package resolution, macro pattern
  recognition, document symbols, Find References, workspace indexing, and cache
  persistence.
