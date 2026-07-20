# C# Language Tooling Coexistence for Shader Property References

## Status

Proposed — 2026-07-20; decision draft for
[#94](https://github.com/YukiagoTpf/UnityShaderNav/issues/94).

## Context

[#77](https://github.com/YukiagoTpf/UnityShaderNav/issues/77) evolves
UnityShaderNav into a project-level Shader Intelligence environment.
[#93](https://github.com/YukiagoTpf/UnityShaderNav/issues/93) extends
understanding from Shader source into authoritative Material asset facts. The
next slice ([#94](https://github.com/YukiagoTpf/UnityShaderNav/issues/94))
asks how UnityShaderNav can recognize `Shader.Find`,
`Shader.PropertyToID`, `Material` Set/Get methods, `MaterialPropertyBlock`
Set/Get methods, and keyword setters in C# **without conflicting with the
installed C# language tooling** (C# Dev Kit / C# extension / Roslyn).

The current product is a VS Code extension plus language server that registers
providers only for `shaderlab`, `hlsl`, and `shadergraph` languages. It never
registers C# providers. The Unity Editor Adapter
([ADR-0008](0008-unity-editor-adapter-lifecycle-and-trust-model.md)) is the
trust boundary for all evidence only the Editor can produce. Material usages
([#93](https://github.com/YukiagoTpf/UnityShaderNav/issues/93)) are an
Adapter-supplied overlay on References that never enters the source index.

The decision must define ownership of Completion, Definition, References,
Rename, CodeLens, and diagnostics; conservative handling of constant and
dynamic strings; and privacy, performance, project reload, and C# tool
unavailable behavior.

## Options considered

| Criterion | Document-provider registration | Project fact import | Roslyn / Unity Adapter facts | Conservative text indexing |
| --- | --- | --- | --- | --- |
| Conflict with C# tooling | High: registers a second provider for `csharp` that VS Code merges or ranks | Low: imports facts without registering C# providers | Low: facts flow through the existing Adapter overlay | Low: text scanning does not require registering a C# provider |
| Authoritativeness | Low: text-only, no type resolution | Medium: depends on import fidelity | High: Roslyn resolves receiver types, shader flow, binding | Low: no type resolution; cannot distinguish Material.SetColor from an unrelated SetColor; high false-positive rate |
| Stale-position safety | Low: no source revision | Medium | High: per-URI source revision + content hash, validated against current observable source | Low: no revision |
| Privacy / performance | Medium: scans C# source in the extension host | Medium | High: analysis runs in the Editor (Roslyn); extension only validates and projects | Low: full-text C# scanning in the extension host duplicates Roslyn's work and retains C# source for hashing |

Document-provider registration is rejected on conflict and authoritativeness:
it forces a second `csharp` provider that VS Code merges with the C# extension,
and it cannot prove receiver types or shader binding. Project fact import is a
partial measure that still lacks the Adapter trust boundary. Conservative text
indexing is rejected on three grounds — semantic unreliability (without type
resolution it cannot distinguish a shader-property `Material.SetColor` from an
unrelated `SetColor`, producing a high false-positive rate), privacy and
performance (full-text C# scanning in the extension host duplicates the
analysis the C# extension already performs and retains C# source text for
hashing), and duplicate analysis. It does not require registering a C#
provider, but the other grounds disqualify it. Roslyn / Unity Adapter facts
are the only option that reuses the existing architecture (#84 handshake, #93
overlay, AdapterRegistry trust boundary) and provides authoritative,
type-resolved, revision-bound facts without duplicating C# analysis in the
extension host.

## Decision

Adopt the **Adapter-backed authoritative facts** model. UnityShaderNav does
**not** register generic C# Definition, References, Rename, Completion,
Diagnostics, or CodeLens providers. The C# extension (Roslyn) owns all generic
C# language features. UnityShaderNav contributes only shader-property-specific
facts through the existing Adapter overlay pattern, as a narrow References
overlay on ShaderLab Properties — exactly analogous to Material usages in
#93.

### Ownership of editor requests

| Request | UnityShaderNav owns? | Notes |
| --- | --- | --- |
| Completion | No | C# extension owns all C# completion |
| Definition | No (generic C#); yes (Shader Property origin via overlay) | The overlay surfaces PropertyToID / Set call sites as References from the Shader Property, not as generic C# definitions |
| References | No (generic C#); yes (Shader Property usages via overlay) | C# extension owns generic Find References; UnityShaderNav adds shader-property usages as an overlay on the Property's References |
| Rename | No | C# extension owns C# rename; UnityShaderNav never registers a C# rename provider. Shader Property Rename (#96) is a separate, explicitly-triggered operation |
| CodeLens | No | C# extension owns C# CodeLens; any future UnityShaderNav CodeLens needs separate review |
| Diagnostics | No (generic C#); yes (shader-property type-mismatch, when proven) | Type-mismatch diagnostics for proven Material / MaterialPropertyBlock setters are an Adapter overlay, not generic C# diagnostics |

### The `csharp-property-usages` Adapter capability

A new versioned Adapter capability, `csharp-property-usages`, supplies proven
C# call sites. It follows the existing capability pattern: named in the
handshake `supportedFeatures`, versioned independently, and payload-validated
by the AdapterRegistry trust boundary. The capability payload is a list of
`CSharpPropertyUsage` items; each carries the C# file URI, the property-name
token range, the call kind, the receiver type (when provable), the expression
and binding determinism, the bound Shader identity (when proven), an exact
per-URI C# source revision (URI + SHA-256 content hash), and the Adapter
provenance envelope.

`Shader.Find` is **not** a property reference — it is evidence of Shader
identity / data flow. Keyword setters belong to the keyword domain. Neither
appears in property usages or final References. They are separate concerns for
future slices.

### Confidence semantics

Two orthogonal dimensions, both explicit in every usage:

**Expression value determinism** — what the Adapter can prove about the C#
expression that names the property:

| Value | Meaning | Authoritative as reference? |
| --- | --- | --- |
| `constant-string` | A string literal, e.g. `"_MainTex"`. Covers both direct literals and the string argument to `Shader.PropertyToID("_MainTex")` (the int result is runtime-unstable, but the name origin is a provable constant). | Yes, when binding is proven and source is fresh |
| `constant-concat` | Compile-time-resolvable constant concatenation, e.g. `"_" + "MainTex"`. | Yes, when binding is proven and source is fresh |
| `dynamic` | A value the Adapter cannot resolve to a constant. | No |

**Binding determinism** — what the Adapter can prove about which
Shader/Property the call site targets:

| Value | Meaning | Authoritative as reference? |
| --- | --- | --- |
| `proven` | The Adapter resolved the receiver (Material / MaterialPropertyBlock) and the owning Shader, or the call carries an explicit shader identity. | Yes, when expression is provable and source is fresh |
| `name-only` | The Adapter proved the property name but cannot bind it to a specific Shader. | No |
| `unbound` | The Adapter cannot prove the name or the target. | No |

A usage becomes an **authoritative** reference only when the binding is
`proven` **and** the expression is `constant-string` or `constant-concat`
**and** the per-URI C# source revision matches the current source (SHA-256
content hash). Name-only, dynamic, and unbound items remain visible in the raw
Adapter payload for explicit rejection testing but never enter authoritative
References. The authoritative location type (`CSharpPropertyReferenceData`)
exposes only proven fields; its `bindingDeterminism` is always `'proven'` and
its `expressionDeterminism` is always `'constant-string' | 'constant-concat'`.
The type carries no fields that imply unproven items are trusted.

### Source revision and stale-position safety

Each usage carries an exact per-URI C# source revision: the file URI and a
SHA-256 content hash captured by the Adapter. The AdapterRegistry trust
boundary validates the structure of every usage field, that the property name
and shader identity exactly match the requested target (foreign targets are
dropped), and that the source-revision URI matches the usage URI with a
well-formed SHA-256 content hash. The Workspace overlay then re-validates the
content hash against the current observable source through an explicit
`CSharpCurrentSourceProvider` dependency. This provider is required: without it
(or when it returns `null` for a URI), no authoritative reference can be
produced. A stale C# position — one whose content hash no longer matches the
current observable source — never enters References.

The production client does **not** include `csharp` in its documentSelector,
so the server cannot observe open C# buffers through the normal document
registry; a disk read alone cannot prove the current visible revision when the
buffer is unsaved. Therefore the live capability is **not** enabled in
`server.ts` until #95 implements a client-side revision/hash bridge that
distinguishes `open-buffer` (an editor buffer, dirty or clean), `closed-saved`
(read from disk), and `unknown` (not observable) — **without** registering a C#
language provider. The Workspace and WorkspaceManager retain the optional seam
(`csharpCurrentSource`), and the narrow prototype proves the PropertyToID path
using a mock provider. The resolver computes the SHA-256 content hash from the
observed text itself rather than trusting a provider-supplied hash, so a
provider cannot bypass freshness by reporting a stale hash alongside mismatched
text. This mirrors the current-content validation used by Shader Graph
navigation while respecting the no-C#-provider constraint.

### Privacy

C# source facts come only from the local Unity Editor Adapter, bound to the
same machine and user by the ADR-0008 trust model (named pipe / Unix socket,
per-run session token, project-hash scoping). No C# source is uploaded,
transmitted off-machine, or retained in the index or cache. The text is read
only for in-memory SHA-256 comparison and is not stored.

### Performance

The Adapter (Roslyn) performs the heavy C# analysis; the language server only
validates, filters, and projects. The content-hash comparison is a single
SHA-256 per distinct C# URI, memoized per request. The overlay is computed only
when a References request lands on a ShaderLab Property with an active Adapter
connection; no C# file is scanned or indexed by the language server.

### Project reload and C# tooling unavailable

Adapter availability is the three-state ADR-0008 model (`unavailable` /
`connected` / `disconnected`). A disconnect (e.g. Unity domain reload) drops
all C# usage facts and is not an error; reconnect re-requests through the
capability. When no Adapter is available, behavior is byte-for-byte the current
product — there is no C# navigation, no text fallback, and no degradation of
existing shader navigation. C# tooling (C# extension / Roslyn) is independent
and unaffected; UnityShaderNav never registers a C# provider.

## Narrow prototype

The prototype proves one `Shader.PropertyToID` / `Material.Set*` → Shader
Property navigation path: Find References from a ShaderLab Property returns
proven C# call sites (constant-string or constant-concat, binding-proven,
source-fresh) as `CSharpPropertyReferenceLocation` items, alongside existing
source and Material usages. The prototype uses a mock Adapter and does not
register any C# provider.

## Interface for #95 reuse

[#95](https://github.com/YukiagoTpf/UnityShaderNav/issues/95) (C# Property
setters to Shader Property usages) reuses the `csharp-property-usages`
capability, the `CSharpPropertyUsage` / `CSharpPropertyReferenceLocation`
types, the AdapterRegistry validation, and the Workspace overlay. #95 adds
type-checking of supported setters/getters against the Property contract and
focused diagnostics for mismatches — both as further overlays on the same
facts. No new transport or provider registration is needed.

## Non-goals for this slice

- Registering any generic C# provider (Completion, Definition, References,
  Rename, CodeLens, Diagnostics).
- Production-grade text scanning or automatic text fallback for C#.
- `Shader.Find` or keyword setter references (separate domains).
- Persisting C# facts in the index, cache, or any durable store.
- Defining the #95 type-checking or diagnostics payloads.

## Existing decision guardrails

- [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md): C# usage
  facts may annotate or rank candidates but never delete conservative
  Shader source results.
- [ADR-0006](0006-index-lifecycle-and-failure-semantics.md): Adapter
  availability is outside the index lifecycle; C# facts never enter a
  Published indexed revision or cache.
- [ADR-0008](0008-unity-editor-adapter-lifecycle-and-trust-model.md): C#
  facts flow through the same handshake, trust boundary, and provenance
  envelope as every other Adapter capability.

## Consequences

- UnityShaderNav gains one optional, versioned Adapter capability for C#
  shader-property usages, with no C# provider registration and no conflict
  with the C# extension.
- Authoritative references require proven binding, a provable constant
  expression, and a fresh source revision; the raw payload retains
  name-only / dynamic / unbound items only for rejection testing.
- Stale C# positions are excluded by per-URI content-hash validation
  against the current source.
- With no Adapter, behavior is unchanged; C# tooling availability is
  independent and unaffected.
