# Architecture

UnityShaderNav is a VS Code extension backed by a separate language server.

```text
VS Code extension client
  -> vscode-languageclient
  -> language server process
     -> exact-source document analysis
        -> ShaderLab block/structure/token scanners
     -> parser runtime assets
        -> tree-sitter HLSL parser
        -> cache implementation identity
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
- `analysis`: composes one immutable, exact-source `DocumentAnalysis` from
  ordered ShaderLab HLSL/CG blocks, multiline-aware structure, and, on full
  demand, ShaderLab lexical tokens. Indexing, Outline, and Semantic Tokens
  consume this result instead of independently rescanning the same live source.
- `parser/hlsl`: wraps tree-sitter and collects symbols/references.
- `parser/runtimeAssets`: maps only the supported source, tsc-out,
  copied-server, and bundled-server layouts to the vendored HLSL grammar. A
  successful parser attempt captures its bytes once; parser execution and
  cache compatibility consume that same immutable fact.
- `parser/lexical`: owns cursor analysis behind `analyzeCursor` plus the narrow
  `classifyCursor` and gate-free `memberAccessAt` derived interfaces.
- `macros`: is the sole compilation and recognition boundary for built-in and
  user-configured declaration patterns, pragma reference patterns, and
  structural sentinels. Consumers receive only captured domain facts; the same
  module projects built-in declaration heads for lexical coloring and all
  pattern facts for cache identity without exposing compiled representations.
- `vocabulary.ts`: owns the neutral Unity/HLSL/ShaderLab built-in vocabulary,
  stable ShaderLab semantic roles, and narrow projections consumed by
  parsing-derived coloring, Properties, hover, completion, and signature help.
  Consumers cannot import a raw catalog or keep parallel term sets.
- `include` and `packages`: resolve relative includes and Unity Package paths.
  Include path and casing rules depend on a narrow filesystem probe rather than
  direct I/O; Package membership still comes from the resolved lockfile graph.
- `index`: stores symbols, references, visibility, and chain lookup data. Its
  position geometry module owns shared inclusive range containment and
  before-or-at ordering used by index and suggestion visibility rules.
- `suggestions`: classifies completion/signature contexts and exposes one
  candidate-selector interface for completion, member completion, and
  signature intent. The selector owns include visibility, scope/proximity,
  current/include ranking, member inference, overload focus, dedupe, and
  project-over-built-in precedence; separate formatters produce LSP values.
- `handlers`: adapts LSP messages to domain behavior. The document adapter owns
  the open-document registry; every index-backed query adapter calls only the
  Indexed Workspace behavior interface and never receives raw index stores.
- `workspace/indexedRevisionCandidate`: implements the one full-construction
  path shared by cold start, warm cache restore, rebuild, and recovery. It
  resolves the root, Package context, parser runtime identity, cache
  compatibility/restore, and retain-or-fail policy, then
  returns one complete unpublished `IndexedRevisionBuilder`.
- `workspace/indexedSourceMembership`: captures the immutable extension,
  exclusion, user-root, and resolved-Package admission policy for one revision.
  Cold discovery, warm restore, watcher admission, and close fallback all
  consume this same fact; Package context remains package-resolution state.
- `workspace`: serializes each root's lifecycle and mutations, reconciles the
  latest open-document state, applies incremental changes, owns query behavior,
  and is the only publication and cache-persistence caller.
  `PublishedIndexedRevision` is the immutable query view;
  `IndexedRevisionBuilder` is its one-shot mutable candidate; and
  `WorkspaceIndex` is private to those revision types. `WorkspaceManager` owns
  root routing, cross-root query aggregation, the current-open-document
  provider, and the separate status-snapshot sequence.

## Indexing Model

The index is intentionally pragmatic:

- Symbols are name-based and allow multiple candidates.
- Local variables and parameters carry scope ranges.
- One index-owned symbol-selection module applies inclusive scope, declaration
  order, nearest-declaration shadowing, and include-visible global filtering.
  Definition, Hover, chain lookup, Completion, and member Completion consume
  that module instead of rebuilding selection rules.
- Cross-file search is constrained by include-chain visibility where possible.
- Struct member navigation infers receiver type from declarations and narrow
  assignment facts rather than a full type system.
- Completion, member completion, and signature help reuse the same index and
  include-visibility rules as navigation through one candidate selector.
  Curated built-ins are merged only after project candidates, and a project
  name suppresses its built-in counterpart.
- Parser modules may consume the neutral vocabulary but cannot depend on the
  suggestion projection. A transitive dependency-direction test enforces this
  boundary for statically analyzable TypeScript imports, re-exports, `require`
  calls, and dynamic imports. The same guard prevents vocabulary consumers from
  reconstructing ShaderLab keyword, Property-type, state-head, or state-value
  lists.
- Macro consumers cannot parse raw patterns or inspect compiled parameters.
  Declaration collection, pragma references, sentinel filtering, built-in
  macro-head coloring, and cache identity use the macro recognizer's narrow
  interfaces. A dependency guard keeps raw built-in pattern facts private to
  that boundary.
- A `.shader` indexing cycle derives ordered embedded-code blocks and structure
  from one exact source analysis, then passes the blocks to Properties scanning
  and publishes the structure through `FileIndex` for Outline. A full live
  analysis additionally carries the lexical tokens used by Semantic Tokens.
- Preprocessor conditions are not evaluated for navigation, references, or
  completion. A separate presentation-only layer does apply conservative
  preprocessor branch dimming (inactive and variant-gated `#if`/`#ifdef`/
  `#ifndef` branches are visually dimmed via client decorations), but it never
  changes index results or `DocumentAnalysis`. See
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
  -> receive a complete full candidate or fork the published revision
  -> prepare exact-source analysis + parse
  -> prepare optional disk baseline in the candidate
  -> validate openId + version
  -> publish once by swapping the Workspace revision pointer
```

`Workspace` serializes mutation transactions and coalesces document attempts per
canonical URI. Full transactions delegate to the indexed revision candidate
constructor and receive the completed disk/package builder directly; no hidden
Workspace staging handoff or second take operation exists. A parse that finishes
after a newer edit, close, or close/reopen pair cannot publish. Closing restores
the last valid disk index in the candidate; a live-only file is removed.
File-watcher changes fork each eligible owner that can accept incremental work,
update its disk baseline
without replacing an open overlay, and publish the complete candidate once.
Eligibility means an existing disk baseline or the revision's exact indexed
source membership fact, which is also used by scanning and close fallback;
excluded paths and packages absent from the lockfile cannot enter through a
watcher. One Workspace failure does not prevent
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
Each revision also constructs exactly one suggestion candidate selector over
its immutable index view and Include context. A fork publishes a new selector;
an already captured revision continues selecting from its old facts. Include
visibility, shared symbol selection, property bridging, Package
filtering, semantic-token construction, symbol formatting, and multi-candidate
results remain revision-owned behavior.

For a ShaderLab open-document attempt, the candidate builds a full
`DocumentAnalysis` from that attempt's exact source. It becomes query-visible
only when the same candidate publishes. File indexing projects its structure
into `FileIndex` for Outline, while Semantic Tokens consumes its committed
lexical tokens through the captured revision. The analysis container and source
stay beside the live overlay rather than inside `FileIndex`; close or a newer
attempt removes them from the next publication, while an already captured old
revision keeps its immutable facts until that reader finishes. Disk scans
and other index-only source paths may construct an analysis while producing a
`FileIndex`, but discard it immediately afterward; cache restoration does not
reconstruct one. The durable `FileIndex.structure` projection may be cached;
`DiskIndexRecord`, cache manifests, persisted cache entries, and process-wide
caches never retain the analysis container, source text, or lexical tokens.
This revision-owned lifetime prevents Outline or token requests from observing
facts derived from a different source snapshot.

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
revision. Initialization, rebuild, recovery, and warm restore all call the same
candidate constructor. Cache hit and source scan converge on one explicit return
value: a complete unpublished builder for the discovered disk/package baseline.
The constructor does not own lifecycle state, allocate a revision, publish, or
persist. Live edits, close, watcher batches, and settings-only changes instead
fork the current revision.
`WorkspaceIndex.fork()` copies mutable maps and global-index arrays while
sharing immutable per-file indexes. Settings, Package context, indexed source
membership, cache identity, committed document attempts, source warnings, and
effective index data cross the publication boundary together. A one-shot
builder cannot be mutated again after it creates a published revision.

Before full publication, Workspace replays its latest open-document desired
state into the isolated builder. Publication is one synchronous commit after all
construction, parsing, I/O, replay, and attempt validation completes: materialize
the immutable revision, swap the pointer once, commit reconciled close state,
and advance revision/lifecycle status without an intervening `await`. Every
successful externally observable publication increments that Workspace's
session-local `revision` exactly once.
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
submission hands `CacheManager` an immutable disk projection from the published
revision before asynchronous manifest preparation. Cache failures remain
best-effort and cannot invalidate an in-memory publication. See
[ADR-0006](adr/0006-index-lifecycle-and-failure-semantics.md).

Candidate construction consumes parser readiness and resolves runtime assets
before cache work. A missing or unknown grammar layout is classified as parser
initialization failure, so no cache can be restored or persisted for that
attempt. Failed readiness remains retryable for same-process recovery. After
success, the loaded language, grammar SHA-256, and index implementation identity
remain bound to those exact captured bytes even if a watch build later replaces
the file on disk. Cache persistence begins only after Workspace publishes and
remains best effort.

Build-time runtime assembly is owned by one canonical artifact graph under the
repository's `scripts/` Module. The root build materializes copied-server and
bundled-server layouts once, copies the complete grammar and `web-tree-sitter`
runtime trees, and records content hashes for every build input and executable
artifact. Watch, current-run VSIX packaging, package-layout tests, and Electron
short-path staging derive their paths from that graph. Packaging rejects stale
inputs, changed local outputs, missing VSIX entries, or packaged bytes that do
not match the build manifest; an older valid VSIX cannot satisfy the check.

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

Production lifecycle entry points are deliberately narrow: the
Workspace-folder coordinator owns initial registration and live folder events,
scoped settings reconfiguration owns configuration changes, and the file
watcher owns incremental or full rebuild transactions. Rebuild and watcher APIs
do not accept a request-suspension parameter. There is no separate global
settings rebuild or Workspace-folder-change helper exposed only for tests;
tests exercise those production interfaces directly.

## Include Resolution Boundary

Each `PublishedIndexedRevision` owns one Include chain composed from that
revision's immutable index view and the include context captured from its
settings and `PackageContext`. Direct include jumps and transitive visibility
for Definition, References, Hover, Completion, Signature Help, and Document
Highlight consume this same behavior. Forked publications create a new chain;
captured older revisions retain their original view. The chain intentionally
does not memoize across requests, so filesystem state is not promoted to a
process-lifetime cache.

The include resolver owns candidate generation, ordering, exact-case
verification, and case-insensitive fallback above a narrow `FileProbe` with
`exists` and `listDir` operations. Production resolution uses the default Node
filesystem adapter; rule tests inject an in-memory directory tree. The seam
keeps filesystem failures and test setup below the rules without adding I/O
capabilities to Workspace query interfaces or changing the resolver's result
contract.

Package include candidates consume the physical-path map already captured by
the Workspace revision's `PackageContext`. The probe does not discover packages
or broaden package membership. `PackageResolver` exposes only that resolved map;
there is no parallel Package include-path implementation.

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

Each Unity Workspace identity owns one monolithic manifest at:

```text
<UnityRoot>/Library/UnityShaderNavCache/workspaces/<identity-hash>/index.json
```

The hash comes from the canonical Workspace folder URI, using the same file-URI
normalization as document ownership. Parent and nested Workspace folders that
resolve to one Unity root therefore keep independent manifests, while equivalent
Windows drive-letter URIs select and validate the same bucket. Unity-root
validation and persistence coordination use canonical filesystem path identity,
so Windows path casing cannot split one physical manifest into separate queues.
Standalone mode retains its per-workspace bucket under VS Code global storage.

The manifest has a schema version and source fingerprint. The fingerprint
content-addresses the captured server implementation, resolved shared and
external parser runtimes, the exact grammar bytes already accepted by parser
initialization, index-affecting settings, and macro table. It never reopens or
guesses a grammar path. A different or unavailable implementation identity
forces a source rebuild without a manual version bump. Cache contents are limited to the
published revision's disk projection and source identities. Live overlays,
document analysis, lifecycle state, source warnings, and document attempts are
not persisted. Package entries are restored only while the current
`Packages/packages-lock.json` still admits them. In particular, a cached file
outside the Unity root must still belong to a currently resolved external
package; removing a local package cannot turn its old record into a user file.

`CacheManager` coordinates saves by final manifest path across all manager
instances in one language-server process. A path has at most one active request
and one latest pending request. A newer request replaces the pending payload and
inherits its waiters, so intermediate states may be coalesced without losing the
newest process-local request. Active failure rejects that request but still
drains the retained pending request. `CacheStore` writes a same-directory
temporary file and atomically renames it, so a failed replacement preserves the
previous valid manifest.

This ordering guarantee is deliberately process-local. Separate server
processes have neither comparable session revisions nor a shared total order;
atomic rename protects manifest validity but does not define which process is
globally latest. See
[ADR-0004](adr/0004-persist-index-cache-under-library.md).
