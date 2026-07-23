# Architecture

UnityShaderNav is a VS Code extension backed by a separate language server.
Class names, module names, and source paths in this document describe the
current implementation topology; they are not managed vocabulary or a naming
contract. Stable user-facing and domain language lives in
[`CONTEXT.md`](../CONTEXT.md).

```text
VS Code extension client
  -> vscode-languageclient
     -> language server process
     -> exact-source document analysis
        -> one ShaderLab source interpretation
        -> block/layout/name/material/Property/token projections
     -> parser runtime assets
        -> tree-sitter HLSL parser
        -> release cache fingerprint
     -> per-Unity-project Adapter client
        <-> authenticated named-pipe / Unix-domain-socket stream
        <-> Editor-only UPM Adapter
           -> Material Context and versioned evidence capabilities
           -> controlled Visual Lab rendering
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
language-server start. `IndexStatusSnapshot` is the wire-level aggregate of
per-root `WorkspaceIndexStatus` values. Within one LSP session the client
accepts only snapshots with a newer `statusSequence`, and projects multiple
roots to one status-bar state in the order
`failed > indexing > ready > standalone`.

The client also owns the single persistent Visual Lab Webview. It accepts only
validated server snapshots, embeds validated PNG bytes as `data:` images, draws
the validated R8 diagnostic locally, and sends render requests only for the
three explicit Webview actions: pin current selected Material, capture Before,
and capture After. A strict content-security policy permits no network or local
file resource.

## Server

The server owns parsing, indexing, cache restore/persist, and LSP request
handling. Important modules:

- `parser/shaderlab`: interprets each ShaderLab source into width-preserving
  comment/string line facts once, then projects HLSL/CG blocks, layout,
  structure, names, material contracts, Properties/colors, and lexical tokens.
  `ShaderLabLayoutAnalysis` and `ShaderLabLiteralColorFact` are two of these
  current projection types.
  Standalone scanner entry points are compatibility Adapters; production
  composition passes one shared interpretation to every projection.
- `analysis`: composes one immutable, exact-source `DocumentAnalysis` from
  the shared source lines, ordered ShaderLab HLSL/CG blocks, multiline-aware
  structure, name/material/Property facts, and, on full demand, ShaderLab
  lexical tokens. Indexing, Outline, authoring, and Semantic Tokens consume
  this result instead of independently interpreting the same live source.
- `parser/hlsl`: wraps tree-sitter and collects symbols/references.
- `parser/runtimeAssets`: exposes `ParserRuntimeAssets` and maps only the
  supported source, tsc-out, copied-server, and bundled-server layouts to the
  vendored HLSL grammar. A successful parser attempt captures its bytes once;
  parser execution and cache compatibility consume that same immutable fact.
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
  `PackageResolver` reads the resolved lockfile graph; `PackageContext` binds
  those paths and provenance facts to one revision. Include path and casing
  rules depend on a narrow filesystem probe rather than direct I/O.
- `index`: stores `SymbolEntry` records, their `scopeRange` visibility bounds,
  durable `FileIndex` projections, references, visibility, and chain lookup
  data.
- `server/src/sourceLocation.ts`: owns shared inclusive range containment,
  location keys, URI basename formatting, and symbol-to-link conversion used
  across parser, index, suggestion, hover, and Workspace query code.
- `suggestions`: classifies completion/signature requests as
  `SuggestionContext` and exposes one `SuggestionCandidateSelector` interface
  for completion, member completion, and signature intent. The selector owns
  include visibility, scope/proximity, current/include ranking, member
  inference, overload focus, dedupe, and project-over-built-in precedence;
  separate formatters produce LSP values.
- `documentation`: exposes `DocumentationTarget` and `DocumentationResolver`,
  which separate exact cursor interpretation from revision-owned project,
  Package, and compatibility selection.
- `project`: `UnityProjectFacts` captures the Editor version consumed by Quick
  Documentation compatibility checks and presentation-only predefined macro
  Hover values.
- `adapter`: owns one Unity Editor Adapter trust boundary per Unity project,
  local descriptor discovery, framed authenticated RPC, reconnect, multi-root
  routing, and the optional `MaterialSource`, bounded Variant build-evidence,
  versioned `ShaderGraphSource`, `MaterialContextSource`, Visual Lab, and
  compiler-evidence query surfaces. Project, instance, producer version,
  capability, source revision, freshness, disconnect, reconnect,
  selection-generation, request-generation, and payload-limit checks run before
  Adapter facts can reach Workspace behavior; unavailable facts stay explicitly
  unknown.
- `portability`: owns the exact-source report classifier, validated Unity/URP
  version pairs, mechanical edit gate, and the projection from mechanical
  findings to Hint diagnostics and Quick Fixes. Reports consume revision-owned
  `UnityProjectFacts` and `PackageContext`; they never read project metadata
  independently or persist findings in the index/cache.
- `handlers`: adapts LSP messages to domain behavior. The document adapter owns
  the open-document registry; `handlers/documentRequest.ts` centralizes
  snapshot routing, suspension, and neutral-result policy. Every index-backed
  query adapter calls only the `IndexedWorkspace` behavior interface and never
  receives raw index stores. Text-only presentation adapters such as declared
  Variant cost read the current open document directly and do not wait for
  indexed publication.
- `lifecycle/requestSuspender.ts`: exposes `RequestSuspender`, the bounded
  initial request gate; rebuild and watcher paths do not use it.
- `lifecycle/requestCancellation.ts`: centralizes the LSP `RequestCancelled`
  error, caller-only Promise waiting, and cooperative checkpoints for
  request-owned CPU loops.
- `cache`: `CacheFingerprint` is the release compatibility fact,
  `CacheWorkspaceIdentity` selects a Workspace bucket, `CacheManager`
  coordinates process-local saves, and `CacheStore` owns manifest I/O.
- `workspace/indexedRevisionCandidate`: implements the one full-construction
  `IndexedRevisionCandidateConstructor` path through
  `DefaultIndexedRevisionCandidateConstructor`, shared by cold start, warm
  cache restore, rebuild, and recovery. It resolves the root, Package context,
  parser runtime assets, release-cache compatibility/restore, and
  retain-or-fail policy, then returns one complete unpublished
  `IndexedRevisionBuilder`.
- `workspace/indexedSourceMembership`: exposes `IndexedSourceMembership`, the
  immutable extension, exclusion, user-root, and resolved-Package admission
  policy for one revision. Cold discovery, warm restore, watcher admission,
  and close fallback all consume this same fact; Package context remains
  package-resolution state.
- `workspace`: serializes each root's lifecycle and mutations, reconciles the
  latest open-document state, applies incremental changes, owns query behavior,
  and is the only publication and cache-persistence caller.
  `PublishedIndexedRevision` is the immutable query view;
  `IndexedRevisionBuilder` is its one-shot mutable candidate; and
  `WorkspaceIndex` is private to those revision types. `WorkspaceManager` owns
  root routing, cross-root query aggregation, the current-open-document
  provider, and the separate status-snapshot sequence.

## Unity Editor Adapter Boundary

The production Adapter is the Editor-only UPM package under `unity-adapter/`.
It starts through Unity's Editor lifecycle and writes
`Library/UnityShaderNavAdapter/session.json` atomically. The descriptor binds
protocol, Adapter and Unity versions, canonical project hash, Editor instance,
endpoint kind/address, process ID, and one fresh 256-bit token. The extension
never installs the package or edits a project manifest.

Windows binds a current-user named pipe; macOS and Linux bind a Unix domain
socket and descriptor under user-only permissions. Both use the same bounded
32-bit-little-endian-length-prefixed UTF-8 JSON messages. There is no TCP
listener. Before any request or event is accepted, `hello` must match the
descriptor token, protocol version, and project hash, and the descriptor-bound
`welcome` must repeat the instance and producer identities plus a unique
versioned capability list.

`WorkspaceAdapterCoordinator` keys connections by canonical Unity project
identity rather than by open folder spelling. Workspace folders resolving to
the same project bind stable scopes to one registry, one authenticated stream,
and one reconnect loop. Different Unity roots use isolated clients, registries,
tokens, streams, and evidence lifecycles. Discovery and reconnect are
asynchronous and additive: they neither block index publication nor let one
root's disconnect affect another. EOF or domain reload invalidates prior
instance evidence; bounded exponential backoff begins at 1 second and caps at
30 seconds with jitter. See
[ADR-0008](adr/0008-unity-editor-adapter-lifecycle-and-trust-model.md).

Visual Lab is a session-only Adapter overlay above Material Context and the
Published include-point Context selection. `VisualLabService` changes its pin
only for the explicit user action; state reads cannot adopt Unity's current
selection. Before each slot request it re-reads the Material selection, asks the
Adapter to redescribe the final draw, and compares the complete canonical
identity before accepting a response. Per-slot request generations and
cancellation reject late rapid-edit responses.

The `visual-lab-render/v1` UPM capability revalidates the persistent Material
and Shader bytes, explicit pass/stage/entry point, Material and global keywords,
pipeline asset, build target, graphics API, quality level, project color space,
Adapter instance, and controlled input immediately before drawing. It renders
one full-screen triangle through the requested `Material.SetPass` into a hidden
64x64 linear `ARGBFloat` target. It does not load or inspect an arbitrary Scene.
The float readback produces the exact top-left row-major binary R8 NaN/Inf mask
before non-finite channels are sanitized for the display PNG.

Selection, Material, source, Shader Context, pipeline, profile, color space,
Adapter instance, or render-input changes abort work and turn every retained
slot into stale evidence. The old bytes remain available with their original
identity, but capture stays unavailable until a user explicitly pins again.
Targets, frames, and masks are held only by the client/server session
coordinators; they never enter `FileIndex`, a Published indexed revision,
persistent cache, workspace/global storage, project assets, or telemetry. See
[ADR-0013](adr/0013-explicitly-pinned-unity-rendered-visual-lab.md).

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
- Hover derives an exact documentation target from cursor context and the
  document's lexical tokens. A revision-owned documentation resolver prefers
  indexed project or include-visible Package declarations, then applies only
  sourced curated entries compatible with the captured Unity project and
  Package version/source/registry facts. Presentation formatting does not
  decide provenance or compatibility.
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
- A `.shader` indexing cycle interprets one exact source into shared line facts,
  derives ordered embedded-code blocks and structure once, and passes those
  facts to every remaining projection. It publishes the durable projections
  through `FileIndex`; a full live analysis additionally carries source lines
  and the lexical tokens used by authoring and Semantic Tokens.
- The same exact analysis carries a safety-bearing ShaderLab layout and
  Property literal facts. Snippet Completion, Document Color, Color
  Presentation, and Formatting are narrow projections of those immutable
  facts. Formatting can emit only line-leading whitespace edits outside the
  complete protected embedded-block ranges.
- Preprocessor conditions are not evaluated for navigation, references, or
  completion. A separate presentation-only layer does apply conservative
  preprocessor branch dimming (inactive and variant-gated `#if`/`#ifdef`/
  `#ifndef` branches are visually dimmed via client decorations, with a
  theme-adaptive marker distinguishing variant gates), but it never changes
  index results or `DocumentAnalysis`. See
  [ADR-0005](adr/0005-conservative-preprocessor-branch-dimming.md).

## Live Documents and Indexed Query Boundary

The document adapter is the only source of editor document identity. It
projects each editor state to an immutable `IndexedDocumentSnapshot`; every
open session receives an `openId`, and each snapshot also carries the LSP
version. The registry coalesces edits while lazy workspace creation is pending
and exposes every new snapshot to request routing immediately, but delays
background edit routing by 75 ms so a burst of versions becomes one reconcile.
It always routes the current snapshot rather than a captured stale value; if a
slow lazy route outlives that window, its completion schedules any newer
snapshot instead of consuming it.

```text
didOpen / didChange / didClose
  -> open-document snapshot registry
  -> Workspace.updateDocument / closeDocument
  -> receive a complete full candidate or fork the published revision
  -> prepare exact-source analysis + live incremental parse
  -> prepare optional disk baseline in the candidate
  -> validate openId + version
  -> publish once by swapping the Workspace revision pointer
```

Each `Workspace` owns the live tree-sitter state for its open overlays. One
session is identified by canonical URI plus `openId`; a monotonically assigned
generation prevents late parser creation or parse completion from entering a
later close/reopen session. Calls within a session use one queue. HLSL-like
files retain one tree, while a `.shader` retains an ordered forest matching its
embedded HLSL/CG blocks. An edit is computed between the stabilized old and new
block sources in the JavaScript parser's UTF-16 coordinate space; unchanged
blocks keep their existing trees and changed blocks pass the edited old tree to
tree-sitter. Both incremental and full parsing feed the same symbol/reference
collector and must project an identical `FileIndex` for the same exact source.

Persistent tree state is exclusive to live overlays. Source discovery, watcher
updates, disk fallback, and other disk reads that require parsing use the full
path; an exact live/disk source match may reuse the already projected
`FileIndex`. A full parser and every temporary block tree are released after
that durable projection. Close, close/reopen, ownership transfer, and
`Workspace.dispose()` retire the corresponding live session. An active attempt
temporarily owns its in-flight trees until it observes the retired generation,
then releases those trees and its parser without publishing them.

`Workspace` serializes full lifecycle and watcher transactions and coalesces
document attempts per canonical URI. While rebuild or recovery constructs an
isolated full candidate, each URI may instead fork and publish from the current
serving revision. A synchronous compare-and-swap immediately before publication
prevents concurrent URI candidates from replacing facts published by a peer;
the lifecycle advances `servingRevision` without ending the full operation.
`OpenDocumentReconciler` owns the desired-state reducer,
`openId + version` ordering, close tombstones, and the single transition that
prepares and commits an open snapshot or restores a closed snapshot. Immediate
mutations apply that transition to a fork of the published revision; full
initialization and rebuild replay apply the same transition to their isolated
candidate. The adapters differ only in publication timing and current-candidate
guarding. A close published beside a full candidate remains desired until that
candidate replays or fails, so an older private overlay cannot be revived.
Full transactions delegate to the indexed revision candidate
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

Each document-position request constructs one `CursorRequestFacts` from the
immutable request snapshot. If the captured revision owns a `DocumentAnalysis`
for that exact `openId + version + sourceText`, the facts reuse its source lines
and precomputed per-line lexical roles plus ShaderLab blocks; otherwise they
split the request text once and derive lexical state on demand. Lexical
preflight and the eventual revision query consume the same cursor, target, and
call facts, so an unpublished HLSL or ShaderLab request has at most one
request-side full-text split and cannot mix facts from another source.

Completion applies its prefix while iterating current and Include-visible
symbols, retains only matching entries, and then applies the existing scope,
rank, and dedupe policy. Both the matching scan and result materialization use
cooperative request checkpoints; large nonmatching sets therefore do not need
to allocate suggestion objects before being rejected.

LSP request adapters carry their `CancellationToken` through Workspace
behavior. The document adapter races lazy routing and asynchronous query waits
against cancellation, while leaving their underlying reconcile or revision
work running. Suspended requests remove only their own waiter. Request-owned
candidate and reference loops check every item and yield a macrotask every 256
items so an in-flight cancellation can surface as `RequestCancelled` rather
than a neutral result.

Material usages are an Adapter-supplied overlay on References, not indexed
source. A request first resolves its ShaderLab Property contract from the same
captured `FileIndex` used by static navigation, then queries the current
`MaterialSource` revision. Matching `.mat` locations carry asset GUID, current
path, serialized-value compatibility, Adapter provenance, complete asset-scope
evidence, and an explicit unknown runtime scope. Material revisions are read on
each request and never create `SymbolEntry`, source-membership, cache, or index
lifecycle state.

C# Shader Property usages are a separate Adapter overlay on ShaderLab Property
References and diagnostics. A narrow server-to-client request reads the exact
open `.cs` buffer, or the closed saved file through VS Code's workspace
filesystem. `AdapterRegistry` accepts only versioned finite accessor contracts,
constant name provenance, bounded ranges, and matching project/producer facts;
the request layer then rechecks every usage against current source. Proven
`Material` and `MaterialPropertyBlock` Set/Get calls are type-checked against
the current ShaderLab Property. Constant `Shader.PropertyToID` flows retain the
name identity but never persist or compare generated integer IDs. Name-only
binding and dynamic-name calls remain explicit uncertain evidence. No C# fact
enters `FileIndex`, source membership, or cache, and the extension registers no
C# language provider.

Safe cross-asset Property Rename is an explicit two-phase command rather than
an LSP Rename side effect. Planning reuses the published source contract plus
current C# and Material overlays, groups every edit by provenance, and hashes
the complete evidence identity. Apply recomputes that identity, asks the
Adapter to prepare revision-checked Material updates, applies exact-old-text
source edits, and commits. Cancellation rolls back the prepared transaction;
commit failure rolls back Material mutations before the client applies the
inverse source edit. Prepared transactions expire and are invalidated by
Workspace disposal or Adapter reconnect. See
[ADR-0011](adr/0011-two-phase-cross-asset-property-rename.md).

Variant comparison is another Adapter-supplied overlay and remains outside the
source index. `variantBuildEvidenceSource` accepts only aggregate rows (at most
2,048 Shader Contexts, 256 keyword sets per Context, and 8,192 sets total) and
`AdapterRegistry` rejects malformed, oversized, foreign-producer, future,
connection-changed, or source-drifted snapshots. `variantComparison` derives
stage-specific Declared/static upper bounds from the current document, joins
them to trusted Compile candidates and Kept measurements by Shader,
SubShader/Pass, Stage, build target, and graphics API, and ranks exact-integer
keyword-set gaps. Failed and incomplete build status is carried alongside any
validated partial rows; no unavailable count is converted to zero. The client
presents this through an explicit report command, while the existing
Declared/static CodeLens remains source-only.

The repository Shader budget verifier reuses the same declared-cost analyzer,
Variant comparison join, and bounded build-evidence validator in an offline
root command. Its versioned contract selects Shader/Pass/stage/platform
Contexts, uses exact arbitrary-precision decimal counts, and snapshots Context
plus keyword-set baselines. Kept budgets accept only completed evidence with a
current source SHA-256. The stable report has no timestamp or absolute path;
failed and unverified results both produce a non-zero CI exit.

The repository Shader compile contract is the orchestration boundary above
profiled `shader-messages`, the static SRP Batcher material checker, and the
offline Variant budget verifier. It preserves each evidence class and status
instead of collapsing absence into success. Exact source hashes and exact
profile identities bind committed compiler captures to selected scopes; the
contract's explicit unverified policy controls CI without changing report
truth.

GPU capture correlation is a separate Adapter overlay with capability
`gpu-capture-correlation/v1`. The first seam accepts only a bounded,
sanitized macOS/arm64/Metal/Xcode evidence envelope for one controlled draw.
It binds capture/tool/GPU/project provenance, Shader Context, current asset
GUID, source SHA-256, and exact expected source text. Real capture verification
also independently checks trace hash/size/name and the command-buffer label;
the checked-in no-trace fixture has an explicit lower trust status. Source or
asset drift produces `stale` before navigation; replay/trace incompatibility
is `unavailable`; absent exact line mapping is `unmapped`. Raw `.gputrace` data
remains tool-owned local derived state and never enters the index or cache. See
[ADR-0012](adr/0012-macos-metal-capture-source-correlation-prototype.md).

File-mode Shader Graph Custom Function usages are another Adapter-supplied
overlay. Adapter-owned version decoders emit one serialization-neutral logical
node contract: graph/source identities, source ranges, precision, ordered
ports, and provenance. `.shadergraph` assets never enter source membership or
the persistent cache. Definition validates the exact open graph content hash
before matching the precision-suffixed HLSL declaration; HLSL References
validate each saved graph hash before returning node locations. Both directions
require an exact `void` function signature, including ordered parameter names,
types, and output directions. An unadvertised capability or unsupported Shader
Graph version remains an explicit unknown status, so the language server never
decodes or guesses Unity-owned serialization fields.

Selected Material Context is a separate Adapter overlay. The registry stamps
one selection with project/instance/producer provenance and forces global plus
engine-added keywords to `unknown`. Workspace then resolves both reported
asset paths under the current Unity project, matches their canonical URIs,
checks the selected Shader declaration, and hashes the current Material and
published/live Shader source before binding the evidence to one publication
ID. The ephemeral store is ignored after any publication and cleared on
Adapter selection/reconnect events or Workspace disposal. Completion metadata
annotates matching Property, texture, and keyword names; Definition and
Completion use stable ranking partitions that retain every conservative
candidate. No Material Context fact enters `FileIndex`, source membership,
cache, or index lifecycle state, and no asset selection is treated as final
draw evidence.

Compiler evidence is another Adapter-owned, session-only overlay. One selected
include-point Context plus one Adapter-discovered compile profile requests exact
Source snapshots and Preprocessed/Generated texts. The trust boundary validates
project, instance, producer, Context, profile, owning Shader revision, and every
source-text SHA-256 before publication. The mapping layer recognizes retained
`#line` directives but publishes a bidirectional line mapping only when the
directive resolves to one supplied source identity and the complete source and
compiler lines are byte-for-byte equal after line-ending separation. Changed
macro lines, unknown/ambiguous identities, invalid line numbers, metadata, and
generated-only code are explicit gaps. Virtual documents carry two fixed
provenance/status lines, so a `CURRENT` to `STALE` transition never shifts map
coordinates. Evidence remains outside `FileIndex`, Published indexed revisions,
and persistent cache.

Push diagnostics are another revision-owned projection. Every lifecycle status
transition requests one coalesced refresh over current open-document attempts.
The publisher computes through Workspace behavior, then rechecks the refresh
generation, Workspace owner, `openId + version`, and captured revision before
sending versioned `textDocument/publishDiagnostics`. Close sends an explicit
empty set, as required by LSP replacement semantics. The first rule resolves
pragma entry names through the same transitive Include chain and symbol
selection as navigation; visible functions, macros, and ambiguous or
variant-dependent candidates suppress false unresolved errors.
Adapter diagnostics first consult current compiler evidence. A proven original
ShaderLab/include line becomes the publication target and its matching
Generated region is attached as related information. A diagnostic whose file,
line, source identity, or mapping cannot be proven is surfaced at the owning
Shader with an explicit unavailable-location note; its reported line is never
clamped into an unrelated source file.

In Auto, diagnostics for a shared HLSL/CG document consume at most 64 known
include-point Contexts from that same immutable revision. Equivalent findings
use range, severity, code, message, and tags as their stable identity; one LSP
diagnostic reports affected/analyzed counts and exposes each exact Context as
`relatedInformation`. Context dimensions remain individually verified or
`unverified`, so an unknown keyword selection, platform, graphics API, Pass, or
stage is never promoted to passing evidence. Static occurrences carry revision
and publication identity. Compiler occurrences retain the complete Adapter
provenance envelope and Unity message payload. A newer publication or document
generation cancels its predecessor before the existing revision/document guards
can publish it.

The session-only portability target follows the open document rather than the
cache. Selecting a target recomputes a report through `IndexedWorkspace`, then
requests a diagnostics refresh. A revision exposes Hint diagnostics only for
`mechanical-change` findings that carry a safe edit; the Code Action boundary
checks that classification again before constructing a versioned Quick Fix.
Human rewrites, unsupported semantics, and verification requirements never
cross that boundary. Graphics-profile requests run through `AdapterRegistry`
with the exact document SHA-256 and return explicit passed, failed,
profile-not-supported, or unavailable evidence. Neither static findings nor a
successful compiler attempt changes the report's `not-claimed` equivalence fact.

For a ShaderLab open-document attempt, the candidate builds a full
`DocumentAnalysis` from that attempt's exact source. It becomes query-visible
only when the same candidate publishes. File indexing projects its structure
and ShaderLab name/material-contract facts into `FileIndex` for Outline,
project-wide name queries, diagnostics, and Code Actions, while Semantic Tokens
consumes its committed lexical tokens through
the captured revision. The analysis container and source
stay beside the live overlay rather than inside `FileIndex`; close or a newer
attempt removes them from the next publication, while an already captured old
revision keeps its immutable facts until that reader finishes. Disk scans
and other index-only source paths may construct an analysis while producing a
`FileIndex`, but discard it immediately afterward; cache restoration does not
reconstruct one. The durable `FileIndex.structure`, `FileIndex.properties`,
`FileIndex.shaderLabNames`, and `FileIndex.shaderLabMaterial` projections may be cached;
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
`WorkspaceIndex.fork()` retains persistent roots for URI stores, disk records,
global symbols, and global references. Those roots point to immutable per-file
shards; replacing one file path-copies only that URI and the affected symbol or
reference names, without enumerating the workspace. Insertion order is part of
the persistent representation, so query ordering remains the same as the prior
`Map`-based index. Settings, Package context, indexed source membership, cache
identity, committed document attempts, source warnings, and effective index
data cross the publication boundary together. A one-shot builder cannot be
mutated again after it creates a published revision.

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
success, the loaded language and grammar SHA-256 remain bound to those exact
captured bytes even if a watch build later replaces the file on disk. Only the
bundled-server layout can add the Extension package version and enable
persistence; source, tsc-out, and copied-server development layouts rebuild from
source. Cache persistence begins only after Workspace publishes and remains best
effort.

Build-time runtime assembly is owned by the current
`scripts/runtime-artifacts.cjs` graph. The root build materializes copied-server
and bundled-server layouts once, copies the complete grammar and
`web-tree-sitter` runtime trees, and requires critical paths to be
repository-internal regular files that meet graph-declared minimum sizes.
The VSCE allowlist contains exactly 18 regular files:

- seven Extension files: `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`,
  `images/icon.png`, and the two files under `language-configuration/`;
- the minified `out/extension.js` and `out/server/server.js` bundles;
- the HLSL grammar WASM, provenance, and upstream license under
  `out/grammars/`;
- `web-tree-sitter`'s license, package metadata, JavaScript runtime, and WASM
  under `out/server/node_modules/web-tree-sitter/`; and
- `out/THIRD_PARTY_NOTICES.txt` plus `out/terminateProcess.sh`.

These are the only package paths: source maps remain build output, loose
transpiled client/server modules are absent, and no runtime verification
manifest is emitted. Consequently the only packaged JavaScript files are the
two bundles and `web-tree-sitter/tree-sitter.js`. Both esbuild operations are
minified and retain metafiles. Notice generation derives the bundled package
set from both metafiles and fails closed unless every discovered manifest has
non-empty string `name`, `version`, and `license` fields plus at least one
license file; a failed generation removes any stale notice output.

The graph copies
`node_modules/vscode-languageclient/lib/node/terminateProcess.sh` to
`client/out/terminateProcess.sh`, which becomes
`extension/out/terminateProcess.sh` inside the VSIX. POSIX builds require the
copied file to be executable. After VSCE packaging, the ZIP entry is normalized
to Unix mode `100755` on every host while every other regular entry is
`100644`. The ZIP-library rewrite uses a bounded, same-directory temporary file
and atomic replacement; it does not implement ZIP byte parsing.

Watch, current-run VSIX packaging, package-layout tests, and Electron short-path
staging derive their paths from the artifact graph. Packaging removes the
versioned output from any earlier run, checks required disk files and the VSCE
public file plan before and after packaging, and rejects a missing or trivially
small VSIX; direct VSCE prepublish applies the same file and plan checks. A
failed attempt restores staged metadata before removing only its exact
versioned output. No parallel content manifest is maintained.

The reproducible grammar build verifies the 4,223,843-byte unoptimized output,
runs the pinned `wasm-opt -Oz` from the pinned Emscripten image without network
access, and verifies the 4,223,826-byte checked artifact. The 17-byte reduction
is an artifact-size fact, not evidence of an activation or parsing performance
change.

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
captured older revisions retain their original view. Within one chain, direct
resolution, transitive visibility, and case-verification directory listings
share their in-flight and settled Promises. Resolved misses and expected
directory-read failures remain conservative misses for that revision. The
cached visibility Set is never returned directly; each caller receives an
isolated copy. A new publication starts with an empty chain, so filesystem state
is not promoted to a cross-revision or process-lifetime cache. Shared work has
no per-request cancellation owner: a cancellation-aware caller stops only its
own wait and must not cancel the revision's cached computation. Another request
can join the same in-flight Promise and reuse its eventual result.

The include resolver owns candidate generation, ordering, exact-case
verification, and case-insensitive fallback above a narrow `FileProbe` with
`exists` and `listDir` operations. Production resolution uses the default Node
filesystem adapter; rule tests inject an in-memory directory tree. The seam
keeps filesystem failures and test setup below the rules without adding I/O
capabilities to Workspace query interfaces or changing the resolver's result
contract.

The same revision owns a lazy include-point Context Matrix for shared HLSL/CG
analysis. It derives concrete Shader program, Pass, stage, source location, and
macro state from indexed structural facts and that revision's Include chain.
The client owns the session-scoped selection; the server keeps only an
ephemeral mirror whose publication identity must match before any request can
consume it. Every new publication therefore invalidates the selection to Auto,
and no Context state crosses into the persistent index or cache. Context can
rank navigation candidates but never removes the conservative Definition,
References, or Highlight result set.

Package include candidates consume the physical-path map already captured by
the Workspace revision's `PackageContext`. The same context captures package
version and source facts, preferring each resolved package's manifest version
and using registry/builtin lock versions only as a semantic-version fallback.
The probe does not discover packages or broaden package membership; there is no
parallel Package include-path or documentation-provenance implementation.

Bulk diagnostics is the bounded Matrix consumer: it preserves the Matrix's
deterministic ordering, analyzes only the first 64 known Contexts, and reports
the remainder as omitted/unverified. It never materializes keyword, platform,
or graphics-API cross-products. Compiler profiles use the same aggregation
contract and cap; profile-specific platform/API facts become verified only for
a completed Adapter run, while Unity compiler messages that cannot name a
Pass, stage, include point, or keyword selection leave those dimensions
unverified.

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
malformed. Every dependency entry is validated independently. An entry with an
invalid shape or missing fields required to map its source (for example a git
hash or a non-empty `file:` version) is skipped with one console warning naming
that package, while other valid entries remain indexable. Missing or unreadable
lockfiles, invalid JSON, and invalid top-level or `dependencies` shapes still
invalidate the package state and fail indexing.

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

The manifest has a schema version and source fingerprint. A release fingerprint
contains the Extension package version, the exact grammar hash already accepted
by parser initialization, index-affecting settings, and the macro table. It does
not read or hash the server, shared, or `web-tree-sitter` runtime trees. Source,
tsc-out, and copied-server layouts do not create a persistable fingerprint; a
different release or content fact forces a source rebuild. CacheStore validates
the manifest envelope and expected fingerprint before walking file records.
The compatible fingerprint owns producer semantics, while an exact recursive
runtime decoder separately validates every required and optional `FileIndex`
field, enum, nested range, and ShaderLab projection against the active schema.
Unknown or malformed per-file records are omitted before candidate restore and
eligible disk sources are re-indexed; untrusted values never enter a published
revision. Cache contents are limited to the published revision's disk projection
and source identities. Live overlays, document analysis, lifecycle state, source
warnings, and document attempts are not persisted. Package entries are restored
only while the current
`Packages/packages-lock.json` still admits them. In particular, a cached file
outside the Unity root must still belong to a currently resolved external
package; removing a local package cannot turn its old record into a user file.

`CacheManager` coordinates saves by final manifest path across all manager
instances in one language-server process. A path has at most one active request
and one latest pending request. A newer request replaces the pending payload and
inherits its waiters, so intermediate states may be coalesced without losing the
newest process-local request. Active failure rejects that request but still
drains the retained pending request. This is the only in-process save queue.
`CacheStore` writes immediately to a unique same-directory temporary file and
atomically renames it, so a failed replacement preserves the previous valid
manifest.

This ordering guarantee is deliberately process-local. Separate server
processes have neither comparable session revisions nor a shared total order;
atomic rename protects manifest validity but does not define which process is
globally latest. See
[ADR-0004](adr/0004-persist-index-cache-under-library.md).
