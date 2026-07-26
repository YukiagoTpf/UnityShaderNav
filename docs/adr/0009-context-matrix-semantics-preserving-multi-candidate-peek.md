# Context Matrix Semantics Preserving Multi-candidate Peek

## Status

Proposed — 2026-07-19; decision draft for
[#87](https://github.com/YukiagoTpf/UnityShaderNav/issues/87).

## Context

[#77](https://github.com/YukiagoTpf/UnityShaderNav/issues/77) moves
UnityShaderNav toward context-aware Shader Intelligence.
[#87](https://github.com/YukiagoTpf/UnityShaderNav/issues/87) blocks
include-point Context selection
([#88](https://github.com/YukiagoTpf/UnityShaderNav/issues/88)) and feeds
diagnostics aggregation
([#89](https://github.com/YukiagoTpf/UnityShaderNav/issues/89)). Without one
shared definition of what a Shader Context is, each feature would grow its
own context notion and its own interpretation of how much filtering is
allowed.

The conservative baseline is fixed.
[ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md) indexes all
preprocessor branches and returns every valid candidate through
Multi-candidate Peek; its Status Update already admits an optional
user-supplied `VariantContext` (a set of active `multi_compile` /
`shader_feature` keywords) that may filter Definition, References, and
Highlight candidates to active branches — with a hard guard that a Context
which rules out every candidate returns all of them, and that no Context
means byte-for-byte original behavior.
[ADR-0005](0005-conservative-preprocessor-branch-dimming.md) adds
presentation-only dimming whose four-valued logic prefers `UNKNOWN` over
guessing. This ADR generalizes the single keyword-set dimension into a full
Context identity and pins the cross-feature contract. It changes nothing
about the fallback: with no Context selected, behavior is exactly the
current product.

## Decision

### Shader Context identity

A **Shader Context** is a tuple of seven dimensions:

| Dimension | Meaning | Known from |
| --- | --- | --- |
| Shader | The `.shader` asset that owns the compilation unit | Indexed ShaderLab name/asset facts |
| SubShader/Pass | The program block position (SubShader index, Pass index or name) | Indexed ShaderLab structure |
| Stage | The entry stage (`vertex`, `fragment`, `kernel`, ...) | Indexed pragma reference facts |
| Include point | One concrete chain through which a shared `.hlsl`/`.cginc` file is reached from a program block | The revision's include chain |
| Keyword set | Active `multi_compile` / `shader_feature` keywords per program block | Declared pragmas; user selection |
| Platform | Unity build target | Adapter/build evidence; otherwise `UNKNOWN` |
| Graphics API | Target graphics API | Adapter/build evidence; otherwise `UNKNOWN` |

Every dimension is either a proven fact or explicitly `UNKNOWN`. `UNKNOWN`
is a value, not an omission: consumers must not treat an unknown dimension
as matching, not matching, or passing. Two Contexts are identical only when
all seven dimensions match, with `UNKNOWN` equal only to `UNKNOWN`. In the
first slice, platform and graphics API are always `UNKNOWN` (no build
evidence exists) and material/global keyword state is always `UNKNOWN`;
only Adapter-sourced evidence in later slices may resolve them, with
provenance per
[ADR-0008](0008-unity-editor-adapter-lifecycle-and-trust-model.md).

A Context is **known** only when its source-derived dimensions are grounded
in one Published indexed revision — an actual Shader, program block, stage,
include point, and declared pragma families present in that revision. The
extension never invents Contexts that the revision cannot name.

### The Context Matrix is the bounded known set

The **Context Matrix** for one revision is the set of known Contexts
reachable from that revision's indexed structure: the Cartesian product is
never enumerated. Concretely, the first slice is bounded by:

- Program blocks that actually exist in indexed source
  (Shader × SubShader/Pass × Stage × include point), a set proportional to
  project source size — not to keyword combinatorics.
- Declared pragma keyword families only. A Context carries one keyword
  selection per declared family; the Matrix never materializes the
  cross-product of all families as separate analyzable Contexts.
- A user selects **one** Context at a time (or `Auto`). Bulk analysis such
  as [#89](https://github.com/YukiagoTpf/UnityShaderNav/issues/89) operates
  over an explicitly capped known set and reports the analyzed count
  alongside the affected count.
- Platform and graphics API add no cardinality: they are `UNKNOWN`
  attributes until evidence exists, not enumeration axes.

### Feature consumption contract

| Feature | May do with a selected Context | Conservative floor |
| --- | --- | --- |
| Definition, References, Document Highlight | Rank and annotate candidates by Context association; filter to active-branch candidates | Never silently deletes: if the Context rules out every candidate, all candidates are returned; `Auto` is byte-for-byte current behavior |
| Completion, Signature Help | Rank Context-active candidates first; annotate | Every conservatively visible candidate remains present |
| Hover | Prefer the documentation target matching the selected Context | Unknown compatibility stays neutral per existing rules |
| Semantic Tokens, inactive-region dimming | Resolve variant-gated branches through the Context, per [ADR-0005](0005-conservative-preprocessor-branch-dimming.md) | `UNKNOWN` branches stay visible and undimmed; presentation only, never index filtering |
| Diagnostics | Analyze a bounded known Context set; group equivalent findings with analyzed/affected counts | Unknown or unsupported dimensions are reported as unverified, never as passing |
| Index, cache, lifecycle | None | Context is never embedded in a Published indexed revision or cache manifest; selecting a Context never rebuilds an index |

Navigation core (Definition, References, Highlight) is the MUST-retain
class: a Context may select the candidates it proves active, but it may never
empty the result set. When a Context proves no candidate active, every
conservative candidate survives, exactly as the table above records.
Presentation and analysis features are the MAY-consume class: they may sharpen
what they show, but only within their existing conservative guards.

### Persistence scope

A selected Context is a session-scoped user preference held by the client,
keyed by Workspace folder. It is not written into the index, the cache
manifest, workspace settings, or any Published indexed revision; revisions
stay Context-free and immutable per
[ADR-0006](0006-index-lifecycle-and-failure-semantics.md). The default
selection is `Auto` (no Context). A selection whose Context is no longer
known — deleted Pass, changed pragma set, superseded revision — falls back
to `Auto` observably; it is never silently retargeted to a similar Context
and never mixed across revisions.

### Unknown facts and fallback

With `Auto`, every feature behaves exactly as today:
[ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md) returns all
candidates and [ADR-0005](0005-conservative-preprocessor-branch-dimming.md)
keeps its four-valued `UNKNOWN`-preferring dimming. With a selected Context,
any fact the Context cannot prove remains `UNKNOWN` and follows the same
guards. A Context never upgrades an unproven fact to a proven one; it only
supplies the dimensions it verifiably carries.

## Representative examples

Pinned as acceptance fixtures for
[#88](https://github.com/YukiagoTpf/UnityShaderNav/issues/88).

### Conflicting-branch resolution

`GetAttenuation` is defined under both `#ifdef SHADER_API_METAL` and
`#ifdef SHADER_API_VULKAN` in one include file. With `Auto`, F12 returns
both candidates (Peek). With a selected Context whose graphics-API evidence
resolves one branch `TRUE`, that candidate ranks first; if it is the only
provably active candidate, F12 may jump directly per the ADR-0001 Status
Update. With a selected Context that rules out both, both are returned —
the result is never empty.

### Shared-include analysis

`Lighting.hlsl` is included by a Forward Pass declaring
`multi_compile _ _MAIN_LIGHT_SHADOWS` and by an Unlit Pass declaring no
such keyword. With `Auto`, an `#ifdef _MAIN_LIGHT_SHADOWS` region in the
shared file stays `UNKNOWN` and visible. Selecting the Forward-Pass
include-point Context (Shader, Pass, Stage, include point) resolves the
branch `TRUE`/`FALSE` for dimming, Semantic Tokens, and Completion ranking
in that file; selecting the Unlit-Pass Context resolves it `FALSE`.
Navigation in the shared file selects the declaration the chosen Context
proves active in both cases, and falls back to every valid target when the
Context proves none of them active.

### Variant keyword selection

A Pass declares `shader_feature_local _USE_NORMAL_MAP`. Selecting a keyword
set containing `_USE_NORMAL_MAP` for that Pass ranks completion candidates
from the active branch first and dims the inactive branch; selecting the
empty set reverses the presentation. Material-driven keyword state stays
`UNKNOWN` in both selections — the Context claims nothing about runtime
enablement.

## Non-goals for this slice

- No platform, graphics-API, or material keyword resolution; those
  dimensions stay `UNKNOWN` until Adapter evidence arrives.
- No build-evidence Variant comparison
  ([#91](https://github.com/YukiagoTpf/UnityShaderNav/issues/91)) and no
  compiler-verified diagnostics; declared/static facts only.
- No persisted or shared Context selections across sessions or users.
- No automatic Context inference from the cursor or open file; selection is
  an explicit user action.

## Existing decision guardrails

- [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md):
  Multi-candidate Peek remains the default and fallback; a Context may
  rank, annotate, or filter with the never-empty guard, and `Auto` restores
  byte-for-byte original behavior.
- [ADR-0005](0005-conservative-preprocessor-branch-dimming.md): Context
  consumption in dimming stays presentation-only; `UNKNOWN` still dominates
  `VARIANT` for unproven facts.
- [ADR-0006](0006-index-lifecycle-and-failure-semantics.md): Context
  selection is not an index lifecycle event; revisions remain immutable and
  Context-free, and selection never triggers rebuild or recovery.
- [ADR-0008](0008-unity-editor-adapter-lifecycle-and-trust-model.md):
  future evidence that resolves `UNKNOWN` dimensions arrives through the
  Adapter with provenance and identity checks; unverified evidence cannot
  create known Contexts.

## Consequences

- One Context identity tuple and one consumption contract apply to every
  feature; features cannot grow private context definitions.
- Navigation candidates are never silently deleted, so Context selection
  cannot strand a user on a filtered-out definition.
- Cardinality is bounded by real source structure and an explicit selection
  of one Context; no feature may enumerate keyword × platform × API
  products.
- Stale selections degrade to `Auto`, so context-aware presentation can
  never outlive the revision that justified it.
- Later slices ([#88](https://github.com/YukiagoTpf/UnityShaderNav/issues/88),
  [#89](https://github.com/YukiagoTpf/UnityShaderNav/issues/89)) implement
  against this contract; any feature needing a new dimension must extend
  this ADR first.
