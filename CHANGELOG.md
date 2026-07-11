# Changelog

All notable changes to UnityShaderNav are recorded here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/)
and uses semantic versioning for extension releases.

## Unreleased

### Changed

- Removed completed execution plans, handoff records, duplicated Agent status,
  and the stale roadmap from the current knowledge surface. Git history and
  GitHub Issues remain the durable record of completed work.
- Added fixed public provenance, an upstream license, offline integrity checks,
  and a byte-for-byte rebuild command for the vendored HLSL grammar.
- Cache fingerprints now content-address the running index implementation and
  complete parser runtime package. Parser execution and cache compatibility now
  share one exact, process-stable grammar byte snapshot across source, tsc-out,
  copied-server, and bundled-server layouts; missing or unknown assets cannot
  create a fallback fingerprint or restore stale indexes.
- Partitioned Unity cache manifests by canonical Workspace identity under
  `Library/UnityShaderNavCache/workspaces/<identity-hash>/index.json`. Each
  identity keeps one monolithic manifest, while Package restore eligibility
  remains driven by `Packages/packages-lock.json`; stale external local-package
  records cannot re-enter the index as ordinary project files.
- Moved cache persistence scheduling into `CacheManager`: every final manifest
  path has at most one active and one latest pending request per server process.
  Replaced pending requests share the newest result; active failure still drains
  pending work, and a failed replacement preserves the previous manifest.
  Cache matching and path coordination now use canonical Windows identities
  instead of raw drive-letter or path casing.
- Moved shared shader vocabulary behind a neutral domain interface and added a
  transitive dependency check that keeps parser modules independent of
  suggestion-specific code.
- Narrowed cursor analysis to three runtime entry points and centralized the
  inclusive position geometry shared by navigation and suggestion visibility.
- Added end-to-end index lifecycle status for every workspace root, including
  pull plus full-snapshot notifications, initialization/rebuild revisions,
  actionable infrastructure failures, non-blocking startup request routing
  while a root has no serving index, cancellation-safe folder removal, and
  status-driven Electron test waits.
- Routed open/edit/close, Definition, and Find References through an Indexed
  Workspace behavior boundary. Document attempts now use open-session identity
  plus LSP version, coalesce during lazy startup, replay before ready/rebuild
  publication, reject stale async work, and restore disk state on close without
  exposing mutable index stores to migrated handlers. Equivalent file URIs and
  nested workspace add/remove transitions now preserve exactly one live owner.
- Published every effective index-changing transaction as an immutable
  Workspace revision. Full
  scans build isolated candidates; incremental work uses copy-on-write forks;
  and one pointer swap exposes settings, Package context, document attempts,
  warnings, and index data together. Rebuild and recovery continue serving the
  last-known-good revision and retain it after failure. All index-backed LSP
  queries now use Workspace behavior, while mutable index stores remain private
  to candidate construction.
- Shared one immutable, exact-source ShaderLab `DocumentAnalysis` between file
  indexing, Outline, and Semantic Tokens. Ordered blocks, multiline-aware
  structure, and lexical facts come from one source snapshot; `FileIndex`
  retains only the durable structure projection. Index-only analysis is
  temporary; only a committed open-document attempt retains full lexical facts
  with its published revision. Close or replacement drops them from the next
  publication, while a reader that already captured the prior revision retains
  its self-consistent facts until it finishes. Source analysis is never
  persisted or globally cached.
- Concentrated completion, member completion, and signature candidate policy
  behind one selector captured by each published Workspace revision. Include
  visibility, scope/proximity, current/include ranking, member inference,
  overload focus, dedupe, and project-over-built-in precedence now have one
  production boundary and direct interface plus Extension Host coverage.
- Separated include candidate and casing rules from Node filesystem access
  behind a narrow `FileProbe`. Deterministic in-memory tests now pin candidate
  priority, Package mapping, and case-insensitive fallback while production
  resolution behavior remains unchanged.

### Fixed

- Signature Help now selects the first arity-compatible overload before
  clamping the active parameter, so a second argument focuses a compatible
  two-parameter candidate while retaining one-parameter and ambiguous results.
- Multiline comments containing syntactically valid fake ShaderLab `Pass`
  blocks no longer create Outline nodes or corrupt the following real Pass
  name and range.
- Configuration keys, defaults, validation, live change forwarding, and index
  rebuild behavior now share one checked contract. In particular, changing
  `unityShaderNav.debug.definitionTrace` applies without restarting the
  extension, and invalid nested values no longer replace valid sibling
  defaults.
- Removed direct request-time reindex fallbacks that could publish stale text
  after a newer edit or close. An unpublished live-document request can now join
  only the current registry attempt through Workspace behavior; otherwise it
  remains neutral.
- Revalidated queued file events against the revision active at execution, so
  a rebuild cannot let an old exclusion or Package scope republish a removed
  file. Close tombstones now reject late snapshots from the same editor session,
  former owners reject snapshots after routing transfers, and excluded or
  unlisted live-only files no longer become disk baselines.
- Bound cached file metadata to the same stable source read that produced its
  index. Retaining a last-known-good record now retains its original identity,
  preventing a newer disk timestamp from validating older symbols on restart.
- Repaired the index-cache benchmark to publish through `Workspace.initialize`,
  derive the production cache path, and fail unless warm restore yields a
  non-empty manifest and a queryable symbol.

## 0.0.7 - 2026-05-28

### Added

- feat: workspace symbol search (Ctrl+T) across indexed shader symbols —
  functions, structs, struct members, cbuffers, macros, and globals are
  reachable through VS Code's "Go to Symbol in Workspace" panel. Results
  honor the existing `findReferences.includePackages` policy and skip
  parameters and local variables (issue #19).
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
- feat: bridge ShaderLab Properties ↔ HLSL declarations for F12 navigation
  in both directions (issue #20).
- fix: resolve `git+ssh://` and `git+http://` Unity package URLs to the
  PackageCache directory, matching Unity's transport-agnostic cache layout
  (issue #10).
- fix: resolve `?path=` subpath git packages to
  `Library/PackageCache/<name>@<hash[:10]>` and truncate the lockfile commit
  hash to the same 10 characters Unity uses for all git package cache
  directories. Verified against Unity 2022.3.53f1c1; previously these entries
  were skipped and non-`?path=` git entries with a real 40-character hash
  pointed at a non-existent directory (issue #25).
- feat: expand the curated built-in vocabulary used by completion, signature
  help, and hover with common HLSL intrinsics and types, UnityCG legacy
  sampler/matrix helpers, URP/SRP Core helpers and instancing macros,
  HDRP-specific helpers, additional ShaderLab states, blend/op/stencil
  values, and additional shader semantics (issue #21).
- chore: add a GitHub Actions CI workflow that runs the full test chain
  on Linux under xvfb and caches the `.vscode-test/` download keyed on
  the lockfile (issue #4).

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
