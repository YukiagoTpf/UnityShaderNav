# Changelog

All notable changes to UnityShaderNav are recorded here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/)
and uses semantic versioning for extension releases.

## Unreleased

### Added

- Added an Adapter-backed Variant comparison report for saved Shader assets.
  It compares Declared/static stage upper bounds with Unity Compile candidates
  and Kept Variants per Pass, Stage, build target, and graphics API, ranks the
  largest keyword-set gaps, and retains validated partial facts from failed or
  incomplete builds. Project/producer/source/timestamp drift and unavailable or
  oversized evidence stay explicit instead of becoming zero or measured facts.
  (#91)
- Added a session-only Shader include-point Context picker for shared HLSL/CG
  files. Each published revision derives known Shader, Pass, stage, source
  location, and deterministic macro state; selecting one sharpens inactive
  regions, semantic tokens, completion, and diagnostics while Definition,
  References, and Highlights retain every conservative candidate. Stale or
  deleted include points fall back to Auto without rebuilding unrelated roots
  or persisting the selection in the index/cache. (#88)
- Added declared/static Variant cost CodeLens for explicit `multi_compile` and
  `shader_feature` keyword sets. Each supported pragma shows its normalized set
  multiplier, scope/stage, and program contribution; each program marker shows
  an exact overflow-safe upper bound and largest multiplier. The linked user
  guide documents duplicates, conditional declarations, shared include blocks,
  and why Unity compiled/kept Variant counts can differ.
- Added an opt-in **Variant Context** feature: a status-bar entry and QuickPick
  let the user toggle active `multi_compile` / `shader_feature` keywords for the
  current `.shader` / `.hlsl` document. With a context selected, variant-gated
  branches resolve to active (bright) or inactive (dimmed), and F12 / Find
  References / Highlights prefer active candidates without removing any
  conservative result. The default (no context) behaviour is unchanged.
  (Epic #77, slices #154–#158.)
- Added a presentation-only `UNITY_VERSION` Hover derived from the captured
  project Editor version. Unknown projects stay neutral, and indexed macro
  declarations retain precedence.
- Added `surf` and `vfshader` complete-file ShaderLab snippets, a `vfpass`
  SubShader snippet, and editable alpha, additive, premultiplied, and multiply
  `Blend` states. Their structural gates keep them out of HLSL/CG blocks.
- Added file-local ShaderLab Property Rename from either the Property or its
  matching HLSL/CG declaration/reference. The edit stays inside one `.shader`
  file and refuses include-supplied or ambiguous contracts.
- Added #127 receiver-aware built-in member completion and signature help for
  texture methods, vector swizzles, bounded matrix components, and typed
  built-in declarations, with project members retaining precedence.
- Added Signature Help on any argument line of multiline calls and for project
  struct member methods.
- Added one shared `UnityShaderNav` output channel for client, server, and LSP
  trace messages; standard `unityShaderNav.trace.server` controls; and a
  clickable status bar that opens per-root index details or failure logs.

### Changed

- Reduced the VSIX to an exact 18-file allowlist containing the minified
  Extension and server bundles, parser/runtime assets, generated third-party
  notices, language metadata, and release files. Loose transpiled client/server
  modules and the unused runtime artifact manifest are no longer packaged.
- Made the language-client termination script a graph-owned runtime file and
  normalized its VSIX entry to Unix mode `100755` on every packaging host; all
  other regular entries use `100644`.
- Added pinned `wasm-opt -Oz` verification to the reproducible HLSL grammar
  rebuild. The checked artifact changes from 4,223,843 to 4,223,826 bytes, a
  17-byte size reduction only; it does not establish a runtime performance
  improvement.
- Reused exact-source lines, lexical roles, and cursor facts across each live
  document request; pushed Completion prefix filtering into
  current/include-visible symbol iteration; and made LSP cancellation
  observable during routing, shared Include waits, and long candidate/reference
  scans without cancelling revision-owned work.
- Coalesced rapid live edits into a 75 ms publication window and let
  per-document reconciles publish from the serving revision while rebuild or
  recovery constructs its candidate. Concurrent document publications now use
  a final compare-and-swap, and full replay preserves newer edits and closes.
- Live HLSL and ShaderLab edits now reuse Workspace-owned tree-sitter trees,
  including one ordered tree forest for embedded ShaderLab program blocks.
  Disk indexing remains a resource-bounded full parse, and close or ownership
  transfer releases the live parser state without changing navigation results.

### Fixed

- Rejected malformed persisted `FileIndex` fields recursively before cache
  restore, including ShaderLab Properties, names, material layouts, and nested
  ranges. Eligible files now re-index from disk without publishing untrusted
  cache facts or changing the index lifecycle.
- Released per-document inactive-region decorations and debounce state on
  close, rejected responses from closed document sessions, and skipped
  debounce work for unsupported languages. Definitely inactive branches now
  use plain dimming while variant-dependent branches also carry a
  theme-adaptive marker.

## 0.1.1 - 2026-07-18

### Changed

- Replaced the Marketplace extension icon with a balanced square composition
  that preserves the intended cube proportions at 128×128.

## 0.1.0 - 2026-07-17

### Added

- Added context-scoped ShaderLab snippets for common Properties, Passes, and a
  pipeline-neutral vertex/fragment program; editable color presentations for
  normalized non-HDR Color defaults; and deterministic ShaderLab indentation
  formatting. Formatting emits only leading-whitespace edits, protects complete
  embedded program/include blocks byte-for-byte, and refuses malformed layout.

- Added sourced, cursor-context-aware Quick Documentation for selected
  ShaderLab directives, render states, Property attributes and types, HLSL
  semantics, and SRP helpers. Indexed project or Package declarations take
  precedence; curated Package fallback requires an include-visible built-in or
  default-registry Unity Package in a supported major-version range, while
  unknown, scoped-registry, or incompatible facts remain neutral. Editor,
  project manifest, and embedded package manifest changes now rebuild the
  captured project facts.

- Added conservative SRP Batcher material-contract diagnostics for supported
  scalar/vector ShaderLab Properties missing from `UnityPerMaterial`,
  incompatible field types, and deterministic cross-Pass layout differences.
  Safe single-target insertions are exposed as preferred Quick Fixes; texture,
  conditional, macro-generated, explicitly packed, incomplete, duplicate, and
  ambiguous layouts remain manual or neutral.

- Added versioned VS Code Problems diagnostics for unresolved Shader and
  Compute entry points declared by `#pragma vertex`, `fragment`, `geometry`,
  `hull`, `domain`, `surface`, and `kernel`. Diagnostics share the published
  revision and include visibility model, refresh after every index transition,
  reject stale document/revision results, and clear deterministically on fixes
  and close. Ambiguous, variant-dependent, and macro-backed cases stay neutral.

- Added project-wide ShaderLab name semantics for `Shader`, `Fallback`, Pass
  `Name`, and `UsePass`, including Definition, References, Hover, Completion,
  Workspace Symbols, cache persistence, live-document updates, and conservative
  Rename. Duplicate declarations stay multi-candidate and block Rename; Pass
  references are rewritten using Unity's uppercase canonical form.

- Added conservative Workspace Rename for unambiguous indexed HLSL/CG symbols.
  Prepare Rename and Rename share the same scope, proximity, member, include,
  Package, macro-reference, and published-revision interpretation as Definition
  and References. Supported pragma entry points update with their functions;
  built-ins, Package declarations, ShaderLab Property contracts, invalid or
  colliding names, and ambiguous candidates are refused with an actionable
  message instead of receiving name-only edits.

## 0.0.9 - 2026-07-12

### Changed

- Unified cold discovery, warm cache restore, watcher admission, and close
  fallback behind one immutable indexed-source-membership fact captured by each
  revision. User exclusions and resolved Package boundaries can no longer drift
  between lifecycle paths.
- Centralized inclusive scope, declaration order, nearest-declaration
  shadowing, and include-visible global selection in one index-owned module
  shared by navigation, hover, chain lookup, and project suggestions.
- Centralized Extension runtime assembly in one artifact graph shared by build,
  watch, VSIX verification, package-layout tests, and Electron staging. Builds
  now emit a content-addressed manifest so stale or byte-divergent server,
  grammar, and `web-tree-sitter` artifacts fail current-run packaging.
- Centralized declaration macro and pragma reference recognition, structural
  sentinel filtering, built-in macro-head coloring, configuration diagnostics,
  and cache identity behind one recognizer. Compiled pattern representations
  no longer leak into parser, semantic-token, cache, or test consumers.
- Bound direct include resolution and transitive include visibility to one
  Include chain per published Workspace revision. Definition, References,
  Hover, Completion, Signature Help, and Document Highlight now share the same
  revision facts; the unused parallel Package include-path helper was removed.
- Removed test-only Workspace-folder and global-settings lifecycle entry points,
  plus no-op request-suspension parameters from watcher and rebuild paths.
  Lifecycle tests now exercise the production coordinator, scoped settings,
  and watcher interfaces; request suspension remains limited to cold start.

## 0.0.8 - 2026-07-12

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
- Made the neutral built-in vocabulary authoritative for ShaderLab keyword,
  render-state, state-value, and Property-type roles. Semantic coloring,
  Properties, cursor classification, Completion, Hover, and Signature Help now
  use narrow vocabulary projections instead of caller-local name lists.
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
- Unified cold start, warm cache restore, rebuild, and recovery behind one
  explicit indexed-revision candidate constructor. It now returns a complete
  unpublished disk/package builder after root detection, package resolution,
  parser readiness, cache restore or source discovery, and compatible source
  retention.
  Workspace alone replays current open documents, publishes with one synchronous
  pointer swap, advances revision/status, and starts best-effort persistence.
  The hidden staged-candidate/take protocol, public phase-only bootstrap, and
  synthetic empty test fallback were removed.
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

- `UsePass` now receives ShaderLab keyword semantic coloring, and `2DArray` /
  `CubeArray` Properties receive the same type classification and coloring as
  the other curated Property types.
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
