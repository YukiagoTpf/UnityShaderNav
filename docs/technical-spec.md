# Technical Spec

This document describes the current UnityShaderNav product and implementation
shape. It is not an implementation plan; detailed issue work belongs in GitHub
Issues and git history.

## Goals

UnityShaderNav provides practical VS Code navigation for Unity shader projects:

- Go to Definition for ShaderLab/HLSL symbols.
- Find References for project-authored shader code.
- Conservative completion and signature help for project-indexed symbols and a
  curated Unity/HLSL/ShaderLab built-in vocabulary.
- Document Symbols for fast file outline navigation.
- Document Highlight and semantic coloring for ShaderLab wrapper syntax and
  common HLSL symbols.
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
  - derives exact-source ShaderLab document analysis and parses HLSL syntax
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

## Index Readiness and Failure

Workspace mode and index readiness are independent. A root reports one mode
(`unity` or `standalone`) and one lifecycle state:

| State | Meaning |
|---|---|
| `indexing` | Initial indexing, rebuild, or recovery is in progress |
| `ready` | A complete index revision is available; the status includes its revision and source-warning count |
| `failed` | The indexing operation failed; the status includes a stable category and concise actionable message |

A successful initial, rebuild, watcher, live-document, or settings-only
publication increments that root's revision exactly once. An empty event batch
or watcher transaction with no effective change does not publish; neither does
a stale, superseded, or failed attempt. Missing, unreadable, or malformed
`Packages/packages-lock.json` for a Unity root and shader parser initialization
or bootstrap/rebuild/watcher indexing-engine failures are infrastructure
failures, not valid empty indexes. Root inspection and directory traversal
failures are also surfaced instead of being interpreted as an empty project. A
source discovered for indexing but unreadable when processed is retained from
the previous revision when its index identity is compatible, or skipped when no
previous record exists; either case contributes to the candidate revision's
warning count. An explicit delete still removes the record when its candidate
publishes. The failed root remains present in the manager until it is removed or
a later recovery succeeds. When a previous revision exists, rebuild and
recovery continue serving it; a failed candidate leaves that last-known-good
revision available under `failed(servingRevision)`. Each disk index is paired
with the size and modification time from its stable source read. Retaining an
older index retains that identity as well; cache persistence never samples new
metadata for an older index value.

Recognized package source kinds must contain the fields needed for deterministic
physical-path resolution. For example, git entries require a non-empty hash and
embedded/local entries require a non-empty `file:` version. Unknown future
source kinds with a valid, non-empty identifier remain explicitly skipped with
a warning; blank identifiers and malformed known sources fail the
package-resolution lifecycle instead of silently dropping a package.

The language server provides a pull request plus full-snapshot change
notifications on the normal client connection. Snapshots carry a session-local
`statusSequence` that changes independently of index revisions. The status
request remains available during startup and rebuild work. A short bounded
request gate exists only while initial global settings and the workspace-folder
snapshot are acquired. Once per-root initialization is scheduled, a root
without a serving revision returns the query's neutral LSP result immediately.
During rebuild/recovery, a request already satisfied by the retained revision
captures it instead of waiting; a new unpublished document attempt joins the
queued candidate/reconcile path. Cross-root requests capture the currently
serving roots and never wait for an unrelated root. Clients and test harnesses
can therefore diagnose progress and failure without guessing a settle time.

## Live Documents and Request Consistency

The server represents each open editor state as an immutable snapshot with
`uri`, `languageId`, `text`, `openId`, and `version`. `openId` changes for every
open/close lifecycle; `version` orders edits only within one open lifecycle.
The document registry coalesces edits during workspace discovery and supplies
the same latest snapshots to initial indexing, rebuild, and remove/re-add
replacement workspaces.

Live text is an overlay over the last valid disk index. Each accepted edit or
close forks the immutable published revision into a private copy-on-write
candidate. Parsing and standalone disk reads complete before one final attempt
check; only the current `openId + version` may publish. Close restores the disk
baseline in the candidate, or removes a file that has no disk form in the
candidate's configured scan scope. A closed `openId` remains a tombstone so a
late snapshot from that editor session cannot recreate the overlay. One pointer
swap makes the complete file, global-symbol, global-reference, disk-baseline,
and committed-attempt state visible together. Equivalent file URIs use one
canonical key for both live attempts and disk baselines. Parser/index exceptions
discard the candidate, fail the workspace lifecycle, and are observed by
fire-and-forget document routing instead of becoming unhandled promise
rejections.

For an exact ShaderLab open-document attempt, preparation produces one
immutable `DocumentAnalysis`: ordered HLSL/CG block ranges plus ShaderLab
lexical tokens. The same block ranges feed file indexing and Properties
scanning. A successful publication keeps the full analysis beside that live
overlay in the `PublishedIndexedRevision`, so Semantic Tokens reads facts from
the same committed source and attempt as the index. Close or replacement by a
newer attempt removes it from the next publication; a request that already
captured the prior revision keeps a self-consistent immutable result. Disk and
other index-only paths use a temporary analysis only while creating the
`FileIndex`; analysis and its source text are not fields of `FileIndex`,
`DiskIndexRecord`, cache
manifests, persisted cache records, or a process-wide cache. Cache restoration
therefore restores indexes without reconstructing source analysis.

Workspace routing changes also form an ownership boundary. Adding a nested root
removes its open-document overlays from the former parent before the nested
Workspace serves them; removing that root republishes current snapshots into
the new longest-match owner. Provider-backed workspaces reject external
snapshots once that exact attempt belongs to another owner. Affected serving
owners are temporarily excluded
from request routing until synchronization settles; initializing/rebuilding
owners replay the provider before publication instead of blocking an unrelated
root. Transient lazy owners with no remaining open documents are retired. A
close/reopen during lazy discovery starts a new route for the new `openId` even
if the retired route finishes later. Removing the final owner starts no
background Workspace: the next index-backed document request may start lazy
discovery only while that request's `openId` remains current.

File-watcher events fan out to every serving Workspace whose standalone,
Unity-project, or Package scope contains the URI. Each owner that can accept
incremental work updates a copy-on-write candidate without replacing its live
overlay, then publishes once. Because a queued rebuild may change exclusions or
Package roots, each owner revalidates event scope against its execution-time
base revision before indexing. A failed owner retains its published revision;
fan-out still lets the remaining owners update, so that failure cannot leave
their caches silently stale. A URI is eligible only when that Workspace already
has a disk baseline or when the path passes the same extension, exclusion, and
resolved-Package rules as scanning.

Every index-backed LSP query consumes the Indexed Workspace behavior interface:
Definition, References, Hover, Completion, Signature Help, Document Highlight,
Document Symbols, Semantic Tokens, and Workspace Symbols. Request handlers do
not receive or assemble mutable index stores. When behavior reads indexed
state, the Workspace captures one immutable published revision and performs
include visibility, scope, proximity, member, property, Package, token,
symbol-formatting, and ambiguity behavior inside that boundary. Async work
cannot mix settings or stores from two revisions.

If an index-dependent open-document request's exact attempt is not yet
published, the Workspace first joins that `openId + version` transaction. A
current attempt publishes a complete new revision before the query captures it;
a superseded or failed attempt returns the feature's neutral LSP result. Pure
lexical Completion/Signature Help exits still require a serving Workspace route,
but they neither publish that request document attempt nor read indexed state.
Queries that already match a published attempt do not wait for an unrelated
candidate. No handler repairs a miss by calling an index implementation.

An include Definition does not require a request-document index: it uses the
immutable snapshot to identify the include path and resolves it through the
Workspace-owned include context. Other Definition and References requests join
the current document attempt before reading indexed state.

Every query that reads indexed state captures one `PublishedIndexedRevision`.
Full indexing builds a new `IndexedRevisionBuilder`; incremental transactions
fork the current revision, copy mutable maps/global arrays, and share immutable
per-file index values. All work completes inside the one-shot candidate before
a single synchronous Workspace pointer swap. Rebuild or recovery failure
discards its candidate and continues serving the retained revision. See
[ADR-0006](adr/0006-index-lifecycle-and-failure-semantics.md).

## Indexing Scope

In Unity mode, the server scans user shader files under the detected or
configured Unity project root and package files resolved from
`Packages/packages-lock.json`. User-file scanning respects
`unityShaderNav.excludePatterns`; package indexing instead follows the resolved
lockfile roots and its own Documentation/Samples exclusions.

Standalone mode does not recursively scan the workspace. It indexes open
documents and qualifying file-watcher events incrementally. Paths in
`unityShaderNav.includeDirectories` are include-resolution search roots in both
modes; they are not additional scan roots.

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
struct members in HLSL/CG code. It also merges a curated built-in vocabulary for
common HLSL intrinsics, Unity/URP helper names and macros, semantics, and
ShaderLab states and values. Project symbols are preferred when names collide
with built-ins.

Signature help is also project-index-backed and conservative. It shows indexed
project function signatures for visible free-function calls and may return
multiple candidates when preprocessor or overload-like ambiguity exists.
Built-in functions participate in signature help only when the catalog includes
parameter metadata.

Semantic coloring combines index-derived HLSL tokens with lexical ShaderLab
tokens. For a committed open ShaderLab document, both come from the captured
revision: project symbols come from its file index, while the lexical layer
consumes the exact attempt's full `DocumentAnalysis` instead of rescanning
request text. The lexical pass fills visible ShaderLab and highlight-only HLSL
gaps: ShaderLab blocks, Properties, Tags, render states, preprocessor
directives, include paths, macro-style declaration heads, shader semantics,
and swizzles. Highlight-only tokens do not participate in Go to Definition or
Find References. Conservative inactive-region dimming remains a separate
client presentation layer and does not alter analysis, index, or token facts.

Built-in vocabulary entries and their neutral metadata live behind the single
`server/src/vocabulary.ts` production interface. Parsing-derived semantic
coloring and hover consume that interface directly; completion and signature
help adapt it into suggestion-specific results. Parser modules must not import
suggestion modules, including through transitive imports. When adding a new
category or changing metadata, update the direct vocabulary tests plus the
projection tests for each affected consumer.

Cursor-sensitive features consume the lexical cursor module through three
runtime entry points: full `analyzeCursor`, completion-oriented
`classifyCursor`, and gate-free `memberAccessAt` for navigation resolution.
Lower-level word, prefix, lexical-state, and ShaderLab-context helpers remain
private to that module. Shared range-containment and before-or-at comparisons
use one geometry utility; range start and end positions are both inclusive.

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

Cache records have a schema version and a fingerprint. The fingerprint includes
the actual index implementation, the complete external parser runtime package,
grammar, index-affecting settings, and macro table. The package entry must also
resolve successfully. A missing, malformed, or different implementation
identity is a cache miss and triggers source indexing; it never changes source
files. Standalone mode falls back to VS Code global storage.

## Public Settings

[Configuration](configuration.md) is the canonical list of public settings,
their types, defaults, ranges, and behavior.

## Verification Baseline

Core verification commands:

```powershell
npm run check:fast
npm run test:package
npm test
```

Use focused server tests while developing, then run the authoritative fast,
current-package, and aggregate commands before publishing or merging
user-visible behavior changes.
