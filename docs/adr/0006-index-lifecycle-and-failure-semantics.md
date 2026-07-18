# Index Lifecycle and Failure Semantics

## Status

Accepted — 2026-07-10; implemented by
[#61](https://github.com/YukiagoTpf/UnityShaderNav/issues/61), with cache
persistence ordering refined by
[#62](https://github.com/YukiagoTpf/UnityShaderNav/issues/62).

## Context

Workspace indexing currently crosses file discovery, package resolution, parser
initialization, cache restore, live-document overlays, and persistent cache
writes. Treating every exception as a skipped file makes a parser or grammar
failure indistinguishable from a legitimately empty project. Clearing the
published index before a rebuild also leaves requests with either partial data
or no data at all.

The lifecycle needs one public contract before status reporting, concurrent
publication, and cache scheduling can be made reliable. That contract must keep
ordinary source-file failures local while making failures that invalidate the
whole indexing operation visible.

## Decision

### Ownership and publication boundary

`Workspace` is the lifecycle Module for one workspace root. It owns one
published indexed revision and its matching settings, macro table, Unity root,
package context, and cache fingerprint. Index construction is an internal
Implementation: handlers may query a published revision, but must never observe
its builder or the mutable stores used to construct it.

Publishing is a single Seam. A full scan, rebuild, watcher batch, accepted live
edit, or close operation prepares all changes before swapping the current
revision. The operation either publishes the complete candidate or publishes
nothing.

The implementation names that boundary directly:

- `PublishedIndexedRevision` is the immutable, request-capturable behavior
  object. Its `WorkspaceIndex`, committed-document map, and source-warning set
  are private.
- `IndexedRevisionCandidateConstructor` is the full-construction boundary used
  by cold start, warm cache restore, rebuild, and recovery. Its default
  implementation resolves the root, Package context, parser runtime assets,
  release-cache eligibility, cache restore or source scan, and compatible source
  retention, then explicitly returns one complete unpublished builder. It owns
  no lifecycle or publication state.
- `IndexedRevisionBuilder` is a one-shot mutable candidate. Full indexing starts
  with an empty builder; incremental work forks the published revision.
- `WorkspaceIndex.fork()` shares persistent roots whose values are immutable
  per-file shards. A candidate update path-copies only the changed URI and the
  affected global names, while retaining insertion order; candidate mutation
  therefore cannot affect the published base or reorder unchanged query data.
- `Workspace` serializes construction, replays the latest open-document desired
  state, and remains the only caller that materializes and publishes a revision.
  It assigns the completed revision to its single current pointer. No
  asynchronous work occurs between materialization, that swap, reconciled-close
  commit, and the matching revision/lifecycle transition.

Full construction has one explicit return value. It must not place a candidate
on Workspace for a later take operation, expose a public phase-only bootstrap,
or synthesize an empty candidate when a test replaces an internal phase.

Each `Workspace` has one monotonically increasing `revision` counter:

- `0` means that no index has ever been published by that workspace instance.
- Each successful, externally observable publication increments the counter
  exactly once. An empty event batch or watcher transaction with no effective
  change does not publish; neither does a stale or superseded attempt.
- A failed operation never increments it.
- The counter orders revisions only within one server session and workspace;
  it is not a wall-clock timestamp or a cross-process identifier.

`WorkspaceManager` owns a separate, monotonically increasing `statusSequence`.
It increments whenever a workspace lifecycle record changes or a root is added
or removed. It orders status snapshots; it does not identify index data. The
sequence is scoped to one LSP session. A reconnect resets the client's
last-seen sequence before it accepts the new server's initial snapshot.

### Mode and lifecycle state are separate

Workspace mode is either `unity` or `standalone`. It describes available
project context, not readiness. Every workspace independently occupies exactly
one lifecycle state:

```text
indexing { operation: initial | rebuild | recovery, servingRevision? }
ready    { revision, warningCount }
failed   { servingRevision?, failure }
```

`servingRevision` is present only when a previously published revision remains
queryable. The allowed transitions are:

```text
absent -> indexing(initial) -> ready(r1) | failed(no revision)
ready(rN) -> indexing(rebuild) -> ready(rN+1) | failed(serving rN)
failed(rN?) -> indexing(recovery) -> ready(rNext) | failed(serving rN?)
failed(serving rN) -> failed(serving rN+1) for a compatible live or settings-only transaction
any state -> absent
```

Incremental and live-document transactions normally move directly from
`ready(rN)` to `ready(rN+1)`. If one encounters an infrastructure failure, the
workspace moves to `failed(serving rN)` without exposing its candidate.

An empty revision is valid only after discovery, package resolution, parser
initialization, and candidate construction all succeed and there are no
indexable files. Standalone mode may therefore publish an empty revision.
Infrastructure failure can never publish `ready` with an empty or partial
revision.

### Failure classification

Failures fall into three classes:

| Class | Examples | Effect |
| --- | --- | --- |
| Source-file failure | One discovered file cannot be read; a source-level failure is explicitly classified as local to that file | Keep a compatible last-valid record for an existing file; skip a new file; finish the transaction with a warning. If the old record is incompatible with the candidate, abort the candidate instead of mixing identities |
| Infrastructure failure | Root traversal is incomplete; `packages-lock.json` is missing, unreadable, invalid JSON, or has an invalid top-level/`dependencies` shape for a Unity root; grammar/WASM initialization fails; the parser engine throws; an index invariant fails | Abort the entire candidate, retain the last published revision, and enter `failed` |
| Cache failure | Cache entry is invalid, cache load misses, or cache save fails | Rebuild from source or keep serving the in-memory revision; do not change index lifecycle |

Tree-sitter syntax error nodes are normal input and do not by themselves make a
file unindexable. Conversely, an unexpected exception from parser
initialization or indexing is not downgraded to a source-file warning merely
because it occurred while processing one file.

The retain-or-drop policy is deliberate:

- An explicit delete event, or removal from the package set described by a
  valid new lockfile, drops the previous record when that transaction publishes.
- A transient failure obtaining one stable source read for an existing file
  retains its last valid record and increments the operation's warning count,
  but only when that record was produced by an indexing identity compatible
  with the candidate (including parser semantics, declaration-macro rules, and
  package version/path membership). An exception from the indexer itself is an
  infrastructure failure and aborts the candidate.
- A disk record binds its `FileIndex` to metadata captured by the same stable
  read. Retention and cache persistence carry that pair together; they never
  attach current disk metadata to an older retained index.
- The same failure for a file with no previous record skips that file and adds
  a warning.
- If changed indexing semantics make the previous record incompatible, the
  candidate cannot satisfy the retain policy. The operation fails and the whole
  previous revision remains published; it must not combine an old file index
  with new settings or macro rules.
- If workspace discovery cannot establish whether files still exist, the whole
  operation fails; it must not infer deletions from an incomplete scan.

Package membership is part of the candidate revision. A valid lockfile change
may add or remove packages atomically. A missing or invalid lockfile does not
publish a candidate with an empty package set, preserving
[ADR-0002](0002-manifest-driven-package-indexing.md).

### Cache persistence ordering

Cache persistence begins downstream of publication. When persistence is
requested, Workspace immediately submits the published revision's immutable
disk projection to `CacheManager`; manager-side coordination by final manifest
path starts before asynchronous snapshot or manifest preparation. The
projection carries only disk indexes and the source identities captured with
them. Live overlays, document analysis, document attempts, lifecycle state, and
source warnings never cross the cache boundary. Package records remain eligible
only while admitted by the current `Packages/packages-lock.json`.

All `CacheManager` instances in one language-server process share a coordinator
for each final manifest path. A path retains at most one active request and one
latest pending request. When a newer request replaces the pending payload, it
inherits the replaced request's waiters; those coalesced callers settle with the
newest retained request. When the active request settles, the coordinator drains
that pending request rather than serializing every intermediate manifest.

An active failure rejects the active request but does not block pending drain.
`CacheStore` prepares a temporary file in the target directory and atomically
renames it, so a failed replacement preserves the previous valid manifest. A
cache failure remains best effort: the published in-memory revision stays
queryable and its lifecycle does not change.

This latest-request-wins guarantee is scoped to enqueue order within one
process. Workspace revision counters reset across instances and server
processes, so they are not durable cache generations. Atomic rename preserves
file validity when separate processes write, but there is no cross-process
total-order guarantee without a separate epoch, lock, or compare-and-swap
protocol. Cache location and Workspace identity partitioning are defined by
[ADR-0004](0004-persist-index-cache-under-library.md).

### Request behavior

Every request that reads indexed state captures one published revision for its
entire execution, including asynchronous include-visibility work. It cannot
combine stores, settings, package context, or macro rules from different
revisions. Pure lexical early exits and neutral results without a serving
revision read no revision.

| Lifecycle state | Request behavior |
| --- | --- |
| Initial indexing, no revision | After the initial discovery gate is released, return the request's neutral LSP result (`null` or an empty collection), never partial data. Only that short server-startup gate may wait up to its bounded deadline. |
| Ready | Query the captured current revision. |
| Rebuild or recovery with `servingRevision` | A request satisfied by the retained revision queries it immediately. A new unpublished document attempt waits for its queued candidate/reconcile transaction. |
| Failed with `servingRevision` | Continue querying that revision while exposing the failure through status. |
| Failed without a revision | Return the neutral LSP result until recovery publishes a revision. |

The status request is never suspended behind indexing; clients must be able to
diagnose a slow or failed bootstrap. A short bounded gate protects only server
startup while global settings and the initial workspace-folder snapshot are
read. Rebuild and recovery do not suspend requests: a retained revision serves
immediately while its candidate builds. A recovery uses the same explicit
construction and publication rules as a rebuild. Full-rebuild triggers
(relevant settings, package-lock or repository changes, and an explicit retry)
may start recovery.
Parser initialization must discard a rejected initialization promise so an
explicit recovery can retry in the same server process.

While a failure remains unresolved, an open, edit, or close live-document
transaction may publish a new serving revision only when it explicitly uses
the retained revision's settings, package context, macro table, and parser
identity. A settings-only change with the same index semantics may publish by
the same rule. The workspace stays `failed` and keeps reporting the original
failure. Watcher batches are not applied to a failed base; a rebuild-triggering
change or explicit retry starts recovery instead. If the parser infrastructure
is still unavailable, the live transaction publishes nothing.

Cross-root requests such as workspace-symbol search capture a tuple containing
one serving revision per participating root. The request proceeds immediately
with that tuple and temporarily omits roots that have no published revision;
their lifecycle remains visible in status. An empty tuple returns the query's
neutral result after root registration. A slow or failed root never blocks
results from another root that can serve.

### Multi-root and observable status

Roots are independent lifecycle units. One root's indexing or failure neither
blocks requests served by another root nor removes the failed root from the
manager. Removing a workspace folder is the only normal transition that makes
its record disappear.

The server exposes the complete lifecycle snapshot through both:

1. a pull request, so a client cannot miss the initial state; and
2. a changed notification after every externally observable transition.

The conceptual Interface is:

```text
IndexStatusSnapshot {
  statusSequence,
  workspaces: [{ folderUri, mode, lifecycle state }]
}
```

Notifications carry the complete snapshot, not deltas. A client accepts only a
snapshot with a newer `statusSequence` in the current LSP session. Indexing
emits at most operation start and terminal lifecycle notifications per root; it
does not notify per file. Source warnings are summarized by count. Failures
expose a stable category and a concise message, not a stack trace.

`warningCount` describes source warnings in the most recently published
revision, rather than an ever-growing session total. A later publication with
no source warnings resets it to zero. Cache and other best-effort runtime
diagnostics do not change `revision`, `warningCount`, or `statusSequence`.

The client projects the multi-root snapshot to one status-bar state with this
severity order:

```text
failed > indexing > ready > standalone
```

A failed root remains visibly failed even if it can serve an older revision.
`ready` means at least one Unity workspace is ready and no higher-severity state
exists. An empty workspace list, or a list containing only ready standalone
workspaces, projects to `standalone`; it never leaves the client stuck on
`starting`. Per-root details remain available in the snapshot for diagnostics.

### Transition review table

| Event | Transition and publication | Revision served during work | Status observation |
| --- | --- | --- | --- |
| Add root | `absent -> indexing(initial)` | None | Root appears; start notification |
| Initial success | `indexing -> ready(r1)` | None until publish | Terminal ready notification |
| Initial infrastructure failure | `indexing -> failed` | None | Terminal failed notification; root remains present |
| Rebuild start | `ready(rN) -> indexing(rebuild, rN)` | `rN` | Start notification |
| Rebuild success | Atomic candidate publish to `ready(rN+1)` | `rN` until swap | Terminal ready notification |
| Rebuild infrastructure failure | `indexing -> failed(serving rN)`; candidate discarded | `rN` | Terminal failed notification |
| File batch or live edit succeeds | Atomic publish `ready(rN) -> ready(rN+1)` | One captured revision per request | One terminal snapshot if observable state changed |
| Compatible local file failure | Publish retained/skipped-file candidate with warnings | Previous revision until swap | Ready snapshot includes warning count |
| Incompatible retained file during rebuild | Candidate discarded; previous revision and its configuration stay paired | Previous revision | Failed notification with a source-failure category |
| File-batch infrastructure failure | Candidate discarded; `ready(rN) -> failed(serving rN)` | `rN` | Failed notification |
| Valid package-lock change | Rebuild package context and files as one candidate | Previous revision | Rebuild start and terminal notification |
| Invalid package-lock change | Candidate discarded | Previous revision, if any | Failed notification |
| Cache load/restore failure | Continue with source indexing | Previous revision, if rebuilding | No cache-driven lifecycle or status transition |
| Cache save failure | Preserve the previous manifest; drain the latest pending request | Current revision | No lifecycle or status transition |
| Recovery trigger | `failed(rN?) -> indexing(recovery, rN?)` | `rN` when present | Start notification |
| Compatible live open/edit/close while failed | Atomic overlay publish to `failed(serving rN+1)`; original failure remains | `rN` until swap | Failed snapshot with the newer serving revision |
| Remove root | Any state to `absent` | No longer selectable | Full snapshot without the root |

## Existing decision guardrails

This lifecycle does not change earlier semantic decisions:

- [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md): a revision
  preserves all valid definition candidates; publication never chooses one.
- [ADR-0002](0002-manifest-driven-package-indexing.md): package membership is
  still derived only from `packages-lock.json` and is committed with its index.
- [ADR-0003](0003-macro-pattern-whitelist.md): the macro whitelist and user
  declaration patterns are committed with the revision that consumed them.
- [ADR-0004](0004-persist-index-cache-under-library.md): cache remains under
  `Library/` (or standalone global storage) and is a derived, best-effort copy.
- [ADR-0005](0005-conservative-preprocessor-branch-dimming.md): inactive-region
  dimming remains presentation-only and cannot filter a published index.

## Consequences

- Rebuild requires isolated candidate construction plus a single pointer swap;
  clearing the published index before rebuilding is not conforming.
- A published revision is immutable. This gives query handlers a deep Interface
  with high locality: they ask domain questions of one view instead of
  coordinating raw symbol/reference stores.
- Settings, package context, macro patterns, and index data require a shared
  transaction boundary. This can temporarily increase memory during a rebuild
  because the old and candidate revisions coexist.
- Failed workspaces must remain managed and retryable. Parser initialization,
  file walking, and package loading must stop swallowing infrastructure errors.
- Readiness reporting is a projection of lifecycle truth, not a second source of
  truth in the client.
- Cache persistence is downstream of publication. A cache failure cannot roll
  back or invalidate an in-memory revision.
- Cache save ordering is process-local and keyed by final manifest path. It
  cannot infer a durable order from session-local Workspace revisions.
