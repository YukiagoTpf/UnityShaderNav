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
  the open-document registry; Definition and References are thin adapters over
  the Indexed Workspace interface. Other query adapters remain independently
  implemented.
- `workspace`: detects Unity roots, owns each root's index lifecycle, scans
  files, applies changes, owns live-document attempts and navigation behavior,
  and manages persistent cache. `WorkspaceManager` owns root routing, the
  current-open-document provider, and the separate status-snapshot sequence.

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

## Live Documents and Navigation Boundary

The document adapter is the only source of editor document identity. Each open
session receives an `openId`; each immutable snapshot also carries the LSP
version. The registry coalesces edits while lazy workspace creation is pending
and always routes the current snapshot rather than a captured stale value.

```text
didOpen / didChange / didClose
  -> open-document snapshot registry
  -> Workspace.updateDocument / closeDocument
  -> prepare parse + optional disk baseline
  -> validate openId + version
  -> synchronous WorkspaceIndex commit
```

`Workspace` coalesces each URI behind its operation queue. A parse that finishes
after a newer edit, close, or close/reopen pair cannot commit. Closing restores
the last valid disk index; a live-only file is removed. File-watcher changes
update the disk baseline in every serving Workspace whose index scope contains
the URI, then republish any still-open overlay before the operation completes.
Eligibility means an existing disk baseline or the same exact user/package
candidate rules used by scanning; excluded paths and packages absent from the
lockfile cannot enter through a watcher. One Workspace failure does not prevent
the other baseline owners from applying the event. Initial indexing and rebuild
both replay the registry's latest
snapshots before publishing `ready`, including after a workspace remove/re-add
with the editor document still open. Disk baselines and live attempts share the
same canonical file-URI key, so equivalent Windows drive-letter casing cannot
preserve or resurrect a deleted baseline.

The longest matching Workspace is the sole owner of an open document. When a
more-specific root is added or removed, `WorkspaceManager` synchronizes the
provider across both sides of the routing change: the previous owner restores
disk state, while the new owner publishes the registry's current snapshot.
Only owners whose route changed participate, non-serving owners rely on their
pre-publication replay, and a replacement is not request-visible until its sync
settles. A transient lazy Workspace is retired after losing its final open
document. If removing the last owner leaves that document open, the registry
keeps its immutable snapshot; the next Definition or References request can
re-enter lazy discovery without waiting for another edit. Closing during the
transition removes the overlay from every former owner.

Definition and Find References ask the serving Workspace for behavior; they do
not receive `IndexStore`, global symbol, global reference, or include-context
implementations. Their query is ordered behind previously accepted document,
watcher, and rebuild work. Include visibility, scope resolution, proximity
tie-breaks, property bridging, Package filtering, and multi-candidate results
remain inside workspace-owned navigation. Other handlers never call an index
implementation to repair a miss. During their migration they may join the
registry's current attempt through `Workspace.updateDocument`; if no current
snapshot can be published, the miss remains a neutral lifecycle result.
Include Definition is the intentional exception to request-document parsing:
it resolves from immutable request text and include context alone.

## Index Lifecycle and Publication

Each workspace reports monotonically ordered successful index revisions.
Workspace mode (`unity` or `standalone`) is separate from lifecycle state
(`indexing`, `ready`, or `failed`), and multi-root workspaces report each root
independently. The current rebuild path makes its mutable index non-serving
before clearing and rebuilding it, so status deliberately omits
`servingRevision` during rebuild or failure. A request for that root returns its
neutral LSP result instead of waiting indefinitely or observing partial data.
The immutable candidate/publication boundary required by
[ADR-0006](adr/0006-index-lifecycle-and-failure-semantics.md) is a stricter
stage beyond this readiness contract.

At the current stage, revisions advance for successful initialization and
rebuild only. Live-document and watcher mutations are serialized and commit all
affected mutable index structures synchronously, but do not claim a new status
revision. Definition and References are protected by the Workspace operation
queue; the immutable retained-revision swap described by ADR-0006 remains the
next publication boundary.

An unreadable source is retained on the incremental path when a previous record
exists, or skipped with a warning during a full scan. Failures that invalidate
the whole operation—such as incomplete root discovery, invalid package state,
or grammar/parser initialization failure—enter the observable failed state.
Without an immutable retained revision, that root remains non-serving until a
recovery succeeds. Cache failures are best-effort. See
[ADR-0006](adr/0006-index-lifecycle-and-failure-semantics.md).

Lifecycle state is observable through the same LSP connection used by editor
features. The server exposes both an index-status pull request and a changed
notification carrying the complete, folder-URI-sorted snapshot. Root add,
terminal initialization, rebuild start, rebuild completion or failure, and
root removal advance `statusSequence`; successful initialization and rebuild
advance that root's `revision`. Failed roots remain managed and removable so a
malformed package lock or parser startup failure cannot masquerade as an empty
project. Per-root lifecycle operations are serialized, while independent roots
can initialize and rebuild concurrently; one root's initial bootstrap does not
delay another root's status registration. Workspace-folder events are
reconciled against a desired-membership token, so a slow scoped-settings read
cannot resurrect a removed root. Removal synchronously retires routing and
prevents the detached workspace from enqueueing new cache publication; a save
already queued before retirement is ordered before any replacement write.

The status pull is deliberately outside ordinary request suspension, making a
slow or failed bootstrap diagnosable. Indexed request handlers use only a
currently serving workspace and otherwise return their neutral result; they do
not enter the background lazy-bootstrap path. Outside a full-rebuild
suspension, cross-root queries immediately use the roots that can serve. The
current mutable rebuild path still uses one bounded global suspension until all
roots finish; timed-out waiters detach and return neutral results without being
retained. A reconnect starts a new sequence domain; the client resets its
last-seen sequence before accepting snapshots from the new server session.

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
