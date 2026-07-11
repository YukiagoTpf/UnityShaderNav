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

## Index Readiness and Failure

Workspace mode and index readiness are independent. A root reports one mode
(`unity` or `standalone`) and one lifecycle state:

| State | Meaning |
|---|---|
| `indexing` | Initial indexing, rebuild, or recovery is in progress |
| `ready` | A complete index revision is available; the status includes its revision and source-warning count |
| `failed` | The indexing operation failed; the status includes a stable category and concise actionable message |

A successful initialization or rebuild increments that root's revision. A
failed operation does not. Missing, unreadable, or malformed
`Packages/packages-lock.json` for a Unity root and shader parser initialization
or bootstrap/rebuild/watcher indexing-engine failures are infrastructure
failures, not valid empty indexes. Root inspection and directory traversal
failures are also surfaced instead of being interpreted as an empty project. A
source file that disappears or cannot be read during initialization or rebuild
is skipped and contributes to that revision's warning count. The failed root
remains present in the manager until it is removed or a later recovery
succeeds.

Recognized package source kinds must contain the fields needed for deterministic
physical-path resolution. For example, git entries require a non-empty hash and
embedded/local entries require a non-empty `file:` version. Unknown future
source kinds with a valid, non-empty identifier remain explicitly skipped with
a warning; blank identifiers and malformed known sources fail the
package-resolution lifecycle instead of silently dropping a package.

The language server provides a pull request plus full-snapshot change
notifications on the normal client connection. Snapshots carry a session-local
`statusSequence` that changes independently of index revisions. The status
request remains available while ordinary language requests are suspended for
startup or rebuild work. Once a root is registered without a serving revision,
indexed requests return their neutral LSP result immediately rather than wait
on an unbounded bootstrap. Outside a full rebuild, cross-root requests use the
roots already serving. The current mutable full-rebuild path retains a bounded
global request suspension; a timeout detaches its waiter and returns the
request's neutral result. Clients and test harnesses can therefore diagnose
progress and failure without guessing a settle time.

## Live Documents and Request Consistency

The server represents each open editor state as an immutable snapshot with
`uri`, `languageId`, `text`, `openId`, and `version`. `openId` changes for every
open/close lifecycle; `version` orders edits only within one open lifecycle.
The document registry coalesces edits during workspace discovery and supplies
the same latest snapshots to initial indexing, rebuild, and remove/re-add
replacement workspaces.

Live text is an overlay over the last valid disk index. Parsing and standalone
disk reads complete before one final attempt check; only the current
`openId + version` may synchronously update the file, global-symbol, and
global-reference indexes. Close restores the disk baseline, or removes a file
that has no disk form. Equivalent file URIs use one canonical key for both live
attempts and disk baselines. Parser/index exceptions fail the workspace
lifecycle and are observed by fire-and-forget document routing instead of
becoming unhandled promise rejections.

Workspace routing changes also form an ownership boundary. Adding a nested root
removes its open-document overlays from the former parent before the nested
Workspace serves them; removing that root republishes current snapshots into
the new longest-match owner. Affected serving owners are temporarily excluded
from request routing until synchronization settles; initializing/rebuilding
owners replay the provider before publication instead of blocking an unrelated
root. Transient lazy owners with no remaining open documents are retired. A
close/reopen during lazy discovery starts a new route for the new `openId` even
if the retired route finishes later. Removing the final owner starts no
background Workspace: the next Definition or References request may start lazy
discovery only while that request's `openId` remains current.

File-watcher events fan out to every serving Workspace whose standalone,
Unity-project, or Package scope contains the URI. Each Workspace updates its
own disk baseline and reapplies its live overlay. Fan-out waits for every owner,
so one failed owner cannot leave the remaining caches silently stale. A URI is
eligible only when that Workspace already has a disk baseline or when the path
passes the same extension, exclusion, and resolved-Package rules as scanning.

Definition and Find References consume an Indexed Workspace behavior interface.
The Workspace first synchronizes the request document, orders the query behind
earlier accepted mutations, and then performs include visibility, scope,
proximity, member, property, Package, and ambiguity resolution internally.
Request handlers do not assemble mutable index stores. No query handler may
repair a store miss by calling an index implementation; adapters not yet moved
to the deep navigation interface may join the registry's current attempt only
through Workspace behavior. The document/file lifecycle remains the mutation
owner, and an unpublished miss returns the feature's neutral LSP result.

An include Definition does not require a request-document index: it uses the
immutable snapshot to identify the include path and resolves it through the
Workspace-owned include context. Other Definition and References requests join
the current document attempt before reading indexed state.

Successful initialization and rebuild advance the observable index revision.
Current live-document and watcher transactions are ordered and synchronously
committed but do not advance that revision. ADR-0006 defines the stricter future
boundary where every transaction publishes an immutable revision.

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
tokens. The index remains the source for project symbols such as functions,
variables, parameters, structs, struct members, and macros. The lexical pass
fills visible ShaderLab and highlight-only HLSL gaps: ShaderLab blocks,
Properties, Tags, render states, preprocessor directives, include paths,
macro-style declaration heads, shader semantics, and swizzles. Highlight-only
tokens do not participate in Go to Definition or Find References.

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
