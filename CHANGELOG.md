# Changelog

All notable changes to UnityShaderNav are recorded here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/)
and uses semantic versioning for extension releases once public publishing starts.

## Unreleased

### Added

- Public project documentation for users and contributors.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, and open-source-oriented docs
  under `docs/`.
- GitHub issue and pull request templates.

### Changed

- Removed historical implementation plans and local agent progress logs from the
  tracked documentation tree. Git history and GitHub Issues remain the source of
  record for old execution details.
- Moved the original technical specification to `docs/technical-spec.md`.

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
