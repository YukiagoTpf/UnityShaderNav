# Architecture

UnityShaderNav is a VS Code extension backed by a separate language server.

```text
VS Code extension client
  -> vscode-languageclient
  -> language server process
     -> ShaderLab block scanner
     -> tree-sitter HLSL parser
     -> macro pattern recognizer
     -> per-file symbol/reference indexes
     -> workspace/global indexes
     -> LSP handlers
```

## Client

The client contributes file types, settings, activation events, status output,
and language-client startup. The server is copied into the extension output
during build so the packaged extension can launch it. It subscribes before
startup and then pulls the current full index-status snapshot after each
language-server start. Within one LSP session it accepts only snapshots with a
newer `statusSequence`, and projects multiple roots to one status-bar state in
the order `failed > indexing > ready > standalone`.

## Server

The server owns parsing, indexing, cache restore/persist, and LSP request
handling. Important modules:

- `parser/shaderlab`: scans ShaderLab and extracts HLSL/CG blocks.
- `parser/hlsl`: wraps tree-sitter and collects symbols/references.
- `parser/lexical`: owns cursor analysis behind `analyzeCursor` plus the narrow
  `classifyCursor` and gate-free `memberAccessAt` derived interfaces.
- `macros`: recognizes built-in and user-configured declaration/reference
  patterns.
- `vocabulary.ts`: owns the neutral Unity/HLSL/ShaderLab built-in vocabulary
  consumed by parsing-derived coloring, hover, completion, and signature help.
- `include` and `packages`: resolve relative includes and Unity Package paths.
- `index`: stores symbols, references, visibility, and chain lookup data. Its
  position geometry module owns shared inclusive range containment and
  before-or-at ordering used by index and suggestion visibility rules.
- `suggestions`: classifies completion/signature contexts, enumerates visible
  project symbols, formats LSP completion/signature items, and adapts filtered
  vocabulary entries to suggestion results.
- `handlers`: adapts LSP messages to domain behavior. The document adapter owns
  the open-document registry; every index-backed query adapter calls only the
  Indexed Workspace behavior interface and never receives raw index stores.
- `workspace`: detects Unity roots, owns each root's index lifecycle, scans
  files, applies changes, owns live-document attempts and query behavior, and
  manages persistent cache. `PublishedIndexedRevision` is the immutable query
  view; `IndexedRevisionBuilder` is its one-shot mutable candidate; and
  `WorkspaceIndex` is private to those revision types. `WorkspaceManager` owns
  root routing, cross-root query aggregation, the current-open-document
  provider, and the separate status-snapshot sequence.

## Indexing Model

The index is intentionally pragmatic:

- Symbols are name-based and allow multiple candidates.
- Local variables and parameters carry scope ranges.
- Cross-file search is constrained by include-chain visibility where possible.
- Struct member navigation infers receiver type from declarations and narrow
  assignment facts rather than a full type system.
- Completion and signature help reuse the same index and include-visibility
  rules as navigation, then merge curated built-ins only after project symbols.
- Parser modules may consume the neutral vocabulary but cannot depend on the
  suggestion projection. A transitive dependency-direction test enforces this
  boundary for statically analyzable TypeScript imports, re-exports, `require`
  calls, and dynamic imports.
- Preprocessor conditions are not evaluated for navigation, references, or
  completion. A separate presentation-only layer does apply conservative
  preprocessor branch dimming (inactive and variant-gated `#if`/`#ifdef`/
  `#ifndef` branches are visually dimmed via client decorations), but it never
  changes index results. See
  [ADR-0005](adr/0005-conservative-preprocessor-branch-dimming.md).

## Live Documents and Indexed Query Boundary

The document adapter is the only source of editor document identity. Each open
session receives an `openId`; each immutable snapshot also carries the LSP
version. The registry coalesces edits while lazy workspace creation is pending
and always routes the current snapshot rather than a captured stale value.

```text
didOpen / didChange / didClose
  -> open-document snapshot registry
  -> Workspace.updateDocument / closeDocument
  -> create an initial/rebuild candidate or fork the published revision
  -> prepare parse + optional disk baseline in the candidate
  -> validate openId + version
  -> publish once by swapping the Workspace revision pointer
```

`Workspace` serializes candidate construction and coalesces document attempts
per canonical URI. A parse that finishes after a newer edit, close, or
close/reopen pair cannot publish. Closing restores the last valid disk index in
the candidate; a live-only file is removed. File-watcher changes fork each
eligible owner that can accept incremental work, update its disk baseline
without replacing an open overlay, and publish the complete candidate once.
Eligibility means an existing disk baseline or the same exact user/package
candidate rules used by scanning; excluded paths and packages absent from the
lockfile cannot enter through a watcher. One Workspace failure does not prevent
the other baseline owners from applying the event. Initial indexing and rebuild
build a separate candidate and replay the registry's latest snapshots before
the single publication, including after a workspace remove/re-add with the
editor document still open. Disk baselines and live attempts share the same
canonical file-URI key, so equivalent Windows drive-letter casing cannot
preserve or resurrect a deleted baseline.

The longest matching Workspace is the sole owner of an open document. When a
more-specific root is added or removed, `WorkspaceManager` synchronizes the
provider across both sides of the routing change: the previous owner restores
disk state, while the new owner publishes the registry's current snapshot.
Only owners whose route changed participate, non-serving owners rely on their
pre-publication replay, and a replacement is not request-visible until its sync
settles. A transient lazy Workspace is retired after losing its final open
document. If removing the last owner leaves that document open, the registry
keeps its immutable snapshot; the next index-backed document request can
re-enter lazy discovery while that `openId` remains current. Closing during the
transition publishes removal of the overlay from every former owner. A
provider-backed Workspace accepts an external snapshot only while that exact
attempt is still assigned to it, so a request captured before transfer cannot
recreate an overlay in the former owner afterward.

Definition, References, Hover, Completion, Signature Help, Document Highlight,
Document Symbols, Semantic Tokens, and Workspace Symbols all ask a serving
Workspace for behavior. Their handlers do not receive `IndexStore`, global
symbol/reference indexes, settings, Package context, or include context. Each
Workspace behavior that reads indexed state captures one
`PublishedIndexedRevision`, and async query work continues against that same
object even if another publication occurs.
Include visibility, scope resolution, proximity tie-breaks, property bridging,
Package filtering, semantic-token construction, symbol formatting, and
multi-candidate results remain revision-owned behavior.

An index-dependent open-document query whose exact `openId + version` is not
published first joins that document attempt through Workspace behavior. It then
captures the resulting revision, or returns the feature's neutral result if the
attempt was superseded or failed. Pure lexical Completion/Signature Help exits
still require a serving Workspace route, but they neither publish the request
document attempt nor read indexed state. Queries already satisfied by a
published revision do not wait merely because a rebuild candidate is in
progress. Include Definition is the other intentional exception to
request-document parsing: it resolves from the immutable request text and the
captured revision's include context.

## Index Lifecycle and Publication

Each Workspace owns exactly one pointer to its latest immutable published
revision. Initialization and full rebuild create a new candidate; live edits,
close, watcher batches, and settings-only changes fork the current revision.
`WorkspaceIndex.fork()` copies mutable maps and global-index arrays while
sharing immutable per-file indexes. Settings, Package context, cache identity,
committed document attempts, source warnings, and effective index data cross
the publication boundary together. A one-shot builder cannot be mutated again
after it creates a published revision.

Publication is one synchronous pointer swap after all parsing, I/O, replay, and
attempt validation completes. Every successful externally observable
publication increments that Workspace's session-local `revision` exactly once.
An empty event batch or watcher transaction with no effective change does not
publish; neither does a stale, superseded, or failed attempt. A request that
reads indexed state captures the published object, so it observes either the
entire old revision or the entire new revision, never a partially updated mix.

Workspace mode (`unity` or `standalone`) is separate from lifecycle state
(`indexing`, `ready`, or `failed`). During rebuild or recovery, status includes
the last published `servingRevision` and queries continue against it while the
candidate builds. Infrastructure failure discards the candidate, reports
`failed(servingRevision)`, and keeps that last-known-good revision queryable.
An initial failure has no revision and therefore returns neutral results until
recovery succeeds. A compatible live-document transaction may still publish a
new serving revision while preserving the failed status and original failure.

An unreadable source is retained when a compatible previous disk record exists,
or skipped with a warning when no record exists. Failures that invalidate the
whole operation—such as incomplete root discovery, invalid package state, or
grammar/parser initialization failure—discard the entire candidate. Cache
records bind each `FileIndex` to the size and modification time observed by the
same stable source read; retaining an old index also retains that old identity,
so persistence cannot pair old semantics with newer disk metadata. Cache
failures remain best-effort and cannot invalidate an in-memory publication. See
[ADR-0006](adr/0006-index-lifecycle-and-failure-semantics.md).

Lifecycle state is observable through the same LSP connection used by editor
features. The server exposes both an index-status pull request and a changed
notification carrying the complete, folder-URI-sorted snapshot. Root add or
removal, lifecycle transitions, and every revision publication advance
`statusSequence`; only successful revision publication advances that root's
`revision`. Failed roots remain managed and removable so a malformed package
lock or parser startup failure cannot masquerade as an empty project. Per-root
mutation operations are serialized, while independent roots can initialize and
rebuild concurrently; one root's initial bootstrap does not delay another
root's status registration. Workspace-folder events are
reconciled against a desired-membership token, so a slow scoped-settings read
cannot resurrect a removed root. Removal synchronously retires routing and
prevents the detached workspace from enqueueing new cache publication; a save
already queued before retirement is ordered before any replacement write.

The status pull is outside request suspension, making a slow or failed bootstrap
diagnosable. A short bounded gate covers only the initial global-settings and
workspace-folder snapshot read. Once per-root initialization has been
scheduled, indexed handlers select a serving revision immediately or return
their neutral result; rebuilds do not suspend requests. Cross-root queries
capture the currently serving root tuple and never wait for an unrelated root.
Document requests may use the `openId`-guarded lazy route only when a current
open snapshot has lost its owner. A reconnect starts a new sequence domain; the
client resets its last-seen sequence before accepting snapshots from the new
server session.

## Package Resolution

Unity package includes are resolved from `Packages/packages-lock.json`. This
avoids scanning stale package cache folders and matches Unity's resolved package
state. See [ADR-0002](adr/0002-manifest-driven-package-indexing.md).

### Supported `packages-lock.json` source forms

| `source`   | Required fields              | Resolved location                                                  |
| ---------- | ---------------------------- | ------------------------------------------------------------------ |
| `embedded` | `version: "file:<dir>"`      | `Packages/<dir>` under the project root                            |
| `local`    | `version: "file:<path>"`     | `<path>` (absolute) or `Packages/<path>` (relative)                |
| `registry` | `version`, optional `hash`   | `Library/PackageCache/<name>@<hash \|\| version>`                  |
| `builtin`  | `version`                    | `Library/PackageCache/<name>@<version>`                            |
| `git`      | `version: "<scheme>..."`, `hash` | `Library/PackageCache/<name>@<hash[:10]>` for `git+https`, `git+http`, `git+ssh`, and bare `https://...?path=` subpath URLs |

Unity 2022.3 truncates the lockfile `hash` (a 40-character commit SHA) to the
first 10 characters when naming the cache directory, so the resolver does the
same. `?path=` subpath git packages share this naming convention — Unity
extracts only the requested subdirectory into the cache folder, so the resolved
path still points at the package root. Verified against Unity 2022.3.53f1c1
lockfiles. Unknown non-empty source identifiers are skipped with a console
warning rather than being guessed; blank or whitespace-padded identifiers are
malformed. Entries using a recognized source are stricter: missing fields
required to map that source (for example a git hash or a non-empty `file:`
version) invalidate the package state and fail indexing instead of publishing a
partial package set.

## Cache

The workspace index is persisted under `Library/UnityShaderNavCache/` with a
schema version and source fingerprint. The fingerprint content-addresses the
actual server bundle and the external parser runtime package (including its
resolved entry), grammar bytes, index-affecting settings, and macro table; a
different or unavailable implementation identity forces a source rebuild
without a manual version bump. In standalone mode,
cache storage falls back to VS Code global storage. See
[ADR-0004](adr/0004-persist-index-cache-under-library.md).
