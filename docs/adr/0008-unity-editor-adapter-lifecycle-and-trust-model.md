# Unity Editor Adapter Lifecycle and Trust Model

## Status

Proposed — 2026-07-19; decision draft for
[#84](https://github.com/YukiagoTpf/UnityShaderNav/issues/84).

## Context

[#77](https://github.com/YukiagoTpf/UnityShaderNav/issues/77) evolves
UnityShaderNav into a project-level Shader Intelligence environment. Every
slice that needs facts only the Unity Editor can produce — compiler messages
([#85](https://github.com/YukiagoTpf/UnityShaderNav/issues/85)), build
evidence ([#91](https://github.com/YukiagoTpf/UnityShaderNav/issues/91)),
Material usages ([#93](https://github.com/YukiagoTpf/UnityShaderNav/issues/93)),
Shader Graph facts ([#97](https://github.com/YukiagoTpf/UnityShaderNav/issues/97)),
Material Context ([#101](https://github.com/YukiagoTpf/UnityShaderNav/issues/101))
— depends on one independently versioned Adapter hosted inside the Unity
Editor. [#84](https://github.com/YukiagoTpf/UnityShaderNav/issues/84) therefore
blocks that chain: the transport, lifecycle, and trust Interface must be
decided before any feature payload is defined.

The current product is a pure VS Code extension plus language server. It
detects a Unity project root (`Assets/` + `ProjectSettings/`), indexes shader
source, and otherwise never talks to an Editor process. Standalone mode and
conservative Multi-candidate Peek navigation
([ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md)) are the
permanent fallback and must not depend on Adapter availability.

The transport choice is constrained by where the server side lives: the
Adapter runs inside the Unity Editor, a long-running GUI process the user
starts independently. The extension never spawns it. The decision must define
lifecycle management, authentication/trust, cross-platform behavior, Unity
Editor hosting feasibility, versioning/capability discovery, and reconnect
behavior — and must reject stale, foreign-project, disconnected, and
version-incompatible evidence observably.

## Options considered

| Criterion | stdio | localhost HTTP | Named pipe (Windows) + Unix domain socket (macOS/Linux) |
| --- | --- | --- | --- |
| Lifecycle management | Extension owns child lifetime, but the wrong process: the extension cannot spawn the Unity Editor | Port allocation, collision, and orphaned listeners need extra protocol | Endpoint dies with the Editor; a stale socket is detectable by connect failure; one endpoint per project identity |
| Authentication / trust | Parent-child channel inherits process trust | Any local process or browser-rebinding page can reach it; a token becomes mandatory, not optional | Kernel enforces same-machine, and filesystem/ACL rules scope access to the same user; a session token is cheap hardening on top |
| Cross-platform | Uniform, but spawn semantics differ per OS | Uniform | Two endpoint bindings, one protocol; Node `net` covers both with no new runtime dependency |
| Unity Editor hosting | Infeasible: the Editor is not the extension's child | Feasible, but binds a TCP listener inside the Editor process | Feasible with the named-pipe/Unix-socket API surface present in the supported Editor scripting runtimes |
| Versioning / capability discovery | Handshake over the stream | Handshake over requests | Handshake over the stream; transport-agnostic either way |
| Reconnect behavior | Tied to child lifetime; not applicable | Connectionless; a dead server is silent until the next poll | Deterministic disconnect (EOF) gives immediate stale marking and a stable reconnection target |

stdio is rejected on hosting feasibility alone. localhost HTTP is rejected on
the trust criterion: it exposes the evidence channel to every process (and,
without origin checks, every browser page) on the machine, forces mandatory
application-level authentication, and introduces port management the Adapter
does not otherwise need. Named pipes and Unix domain sockets are one option,
not two: they are the same per-OS realization of a local, user-scoped,
process-lifetime byte stream.

## Decision

Adopt a local IPC transport: a Windows named pipe and a macOS/Linux Unix
domain socket behind one length-prefixed JSON protocol, discovered through a
session descriptor under the project's `Library/` directory.

### Transport and framing

The Adapter binds exactly one endpoint per hosting Editor: a named pipe on
Windows or a Unix domain socket in a per-user runtime directory on
macOS/Linux. Messages are length-prefixed (32-bit unsigned little-endian
length) UTF-8 JSON values, identical on both bindings. The extension client
uses only Node's built-in `net` module; the Adapter uses only
Editor-built-in APIs, so neither side adds a runtime dependency and the VSIX
file allowlist is unchanged. There is no TCP listener anywhere in the
design.

### Installation and discovery

Installation is a user action: the user adds the Adapter UPM package to the
project. The extension never edits `Packages/manifest.json` or installs code
into the project silently. Discovery is passive and needs no registry:

1. The language server already knows each Workspace's Unity project root.
2. For each root, the extension reads
   `<UnityRoot>/Library/UnityShaderNavAdapter/session.json`, written by the
   Adapter while it is serving and removed or overwritten when it stops.
3. The descriptor carries `protocolVersion`, `adapterVersion`,
   `unityVersion`, `projectHash`, `instanceId`, `endpoint` (pipe name or
   socket path), `token`, and `processId`. It is written atomically
   (temporary file plus rename), consistent with cache manifest writes in
   [ADR-0004](0004-persist-index-cache-under-library.md).

`projectHash` is SHA-256 over the UTF-8 canonical filesystem path of the
Unity project root, using the platform canonical file identity rules already
defined for document ownership and cache identity. Unity holds an exclusive
project lock while an Editor is open, so at most one Editor serves a given
project and the descriptor has a single writer. A descriptor whose endpoint
refuses connection is stale; the Adapter is treated as unavailable.

`Library/` is the right home for the descriptor for the same reasons as the
index cache: it is git-ignored by default, it is project-local, and deleting
`Library/` resets derived state. The Unix socket itself lives in a per-user
runtime directory so long project paths cannot exceed the socket path length
limit; the descriptor tells the client where it is.

### Handshake and capability negotiation

On connect, the client sends one `hello` message carrying the session
`token`, the client `protocolVersion`, and the Unity project root hash it
expects. The Adapter validates the token and either:

- replies `welcome` with the negotiated `protocolVersion`, `adapterVersion`,
  `unityVersion`, `projectHash`, `instanceId`, and a `capabilities` list of
  `{name, version}` entries; or
- replies `reject` with a stable reason code (`token`, `protocol`,
  `project`) and closes the connection.

`protocolVersion` is a single integer; this slice requires an exact match.
A rejected or version-incompatible connection is reported through extension
status as Adapter-unavailable and never degrades index behavior. A
capability is a named, versioned payload contract. This slice defines only
the handshake; each later feature slice defines its own capability name,
version, and payload schema before implementation. A client must not assume
a capability that is absent from the `welcome` list.

### Local trust assumptions

The trust boundary is the OS user on one machine. The kernel guarantees
same-machine delivery; socket-directory permissions and pipe ACLs scope
access to the owning user; the per-run random session `token` (readable only
in the user-owned descriptor) prevents accidental or scripted cross-process
attach by other programs running as the same user. No TLS is used: there is
no network path to protect. A malicious process running as the same user is
outside the threat model, as it is for every local development tool. Remote
development topologies where the Editor and the extension run on different
machines (SSH, containers, WSL cross-OS) are unsupported: discovery simply
finds no descriptor and the workspace stays in the pure-extension fallback.

### Source and revision identity

Every evidence envelope is bound to identity facts so the extension can
reject what it cannot trust:

- **Project identity**: the `projectHash` above. Evidence whose project hash
  does not match the requesting Workspace's Unity root is foreign and is
  rejected observably.
- **Instance identity**: one `instanceId` per endpoint binding. A reconnect
  with a different instance invalidates every fact from the previous one.
- **Source revision**: evidence about an asset carries the asset GUID and a
  content hash captured by the Adapter at collection time. The extension
  compares it against the identity of its own current source read; a
  mismatch marks the evidence stale instead of presenting it as current.
- **Producer identity**: `adapterVersion` and `unityVersion` travel in every
  envelope, so version-incompatible evidence is rejected observably rather
  than misinterpreted.

### Failure and reconnect behavior

Adapter availability is a three-state client-side fact: `unavailable` (no
descriptor, connect failure, or `reject`), `connected`, or `disconnected`
(the stream dropped after a successful handshake). A disconnect is expected
during Editor domain reloads and is not an error surface.

The client reconnects with bounded exponential backoff (base 1 s, doubling
to a 30 s cap, with jitter). Reconnect work never blocks editor features or
index operations. On a new connection the `instanceId` changes, so all
previously received evidence from the prior instance is discarded and
interested features re-request through their capabilities. Evidence never
outlives the identity facts that validated it: project hash, source
revision, and instance.

Adapter state is not an index lifecycle state
([ADR-0006](0006-index-lifecycle-and-failure-semantics.md)). A disconnect,
reconnect, or rejection must not change a Workspace's `indexing`, `ready`,
or `failed` state, and rejected evidence never discards a Published indexed
revision.

### Data provenance

Every Adapter-supplied fact carries an envelope of `{capability,
adapterVersion, unityVersion, projectHash, instanceId, collectedAt,
sourceRevision?}`. User-visible surfaces must render Adapter provenance so
compiler-verified or asset-derived facts remain distinguishable from static
analysis results. An untagged fact is non-conforming and must not reach a
feature.

### Pure-extension fallback

When no Adapter is available, behavior is byte-for-byte the current product:
Standalone mode, Unity static indexing, and conservative Multi-candidate
Peek are unchanged. Adapter-sourced features are additive overlays; their
absence disables only themselves, with observable status, and never removes
or reorders conservative static results.

## Non-goals for this slice

This slice defines the Interface only. It does not implement or specify:

- any feature payload — compiler messages, Material usages, Variant/build
  evidence, Shader Graph facts, Material Context, or GPU capture correlation
  each get their own capability, schema, and issue;
- automatic Adapter installation or project manifest mutation;
- Editor-to-extension channels other than the single endpoint (no UDP
  discovery, no TCP fallback);
- support for multiple Editors serving one project, or one client attaching
  to several projects' Adapters beyond per-Workspace independence.

## Existing decision guardrails

- [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md): Adapter
  evidence may annotate or rank candidates but never deletes conservative
  results; the no-Adapter path remains the default and fallback.
- [ADR-0004](0004-persist-index-cache-under-library.md): the session
  descriptor reuses the `Library/` placement and atomic-write rationale;
  the project hash reuses the same canonical file identity rules.
- [ADR-0006](0006-index-lifecycle-and-failure-semantics.md): Adapter
  availability is outside the index lifecycle; evidence rejection is not a
  workspace failure.

## Consequences

- The extension gains one optional Adapter client boundary per Workspace
  root; unavailability is a normal, observable state, not an exception.
- The Adapter is an independently versioned UPM package; compatibility is
  gated by the handshake protocol version, and each feature capability is
  versioned independently.
- Both endpoint bindings must be exercised in tests (Windows plus
  macOS/Linux), but framing, handshake, identity, and provenance rules are
  shared and tested once.
- Wiping `Library/` resets Adapter discovery along with the index cache,
  which matches the existing derived-data lifecycle.
- Later slices must name their capability and define payload schema plus
  provenance handling before implementing; they cannot smuggle untagged
  facts through the handshake connection.
