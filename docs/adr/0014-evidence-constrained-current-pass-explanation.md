# Evidence-constrained Current Pass Explanation

## Status

Accepted — 2026-07-24 by
[#104](https://github.com/YukiagoTpf/UnityShaderNav/issues/104).

## Context

Material Context can report that the selected Material identifies one
SubShader/Pass, but that observation is not proof of why Unity selected it.
Shader Context, Variant build evidence, compiler evidence, and generated source
answer adjacent questions and carry different identities. Combining whichever
facts happen to be available into fluent prose would hide missing links and
turn correlation into causation.

The first explanation slice therefore needs one bounded question rather than a
general Shader assistant:

> Why was this Pass selected for the current Material Context?

The answer must remain useful when only part of the evidence exists, while
making it impossible to promote an asset-level Material observation into an
authoritative selection cause. It must also preserve the Adapter, source, and
compiler trust boundaries already established by
[ADR-0008](0008-unity-editor-adapter-lifecycle-and-trust-model.md).

## Decision

### One question and one deterministic authority

Version 1 supports only the question above. A repository-owned deterministic
engine evaluates a bounded, versioned evidence graph. The graph is limited to
256 KiB, 64 nodes, 128 edges, and bounded identifiers before nested evidence is
evaluated. Nested evidence arrays are limited to 256 items. The returned answer
is independently limited to 512 KiB, with at most 2,048 missing-evidence entries
and 2,048 contradictions.

The engine performs no I/O and has no model, telemetry, or persistence
integration. The service and client keep a result only for the current session.
No source or evidence is sent to an external model. Model availability cannot
change, delay, or block an answer.

A future language model may rephrase an already complete structured answer, but
it may not resolve symbols, count Variants, establish compiler truth, fill a
missing edge, settle a contradiction, or authorize an edit.

### Observation and causal claim are different outputs

Every answer has two independent parts:

- **Pass selection observation** reports only what the current Material Context
  says about its selected Shader/SubShader/Pass. It may remain observed even
  when a causal claim is refused.
- **Causal explanation** is supported only when one Adapter-authored
  `pass-selection-decision/v1` edge links the exact Material Context, a current
  locally verified Shader Context, and source Pass. That decision must also
  carry the versioned selection rule that actually fired: a non-empty rule ID,
  human-readable summary, and non-empty named facts authored by the Adapter.
  The complete decision, selection, Program, Material/Shader revision, Context,
  project, Editor instance, stage/entry point, rule, facts, and
  decision-provenance identities must close without contradiction.

The engine never derives a `selection-decision` from matching names, indices,
hashes, compiler text, generated source, or the Material's `selectedProgram`.
Identity closure can attest which Pass was selected; it is not itself an
explanation of why. The Adapter-authored rationale is therefore mandatory
before the engine emits a causal claim.
If a required node or edge is missing, the answer names the missing evidence
and refuses causality. If identities disagree, it names the contradiction and
refuses causality. Invalid or over-limit graphs produce a bounded refusal.

Variant, compiler, and generated-source evidence are corroboration rather than
substitutes for the authoritative decision. When exact links exist, citations
may include all six evidence classes: source Pass, Material Context, Shader
Context, Variant, compiler, and generated source. Missing optional
corroboration is disclosed but does not by itself invalidate an otherwise
closed authoritative selection chain.

The Context citation retains the full current GPU-correlation envelope and its
complete `verified-local-trace` verification. Trace path/hash, capture label,
draw identity, mapped URI/range/Context, expected source text, and source entry
point must match the correlated draw; a status string alone is not
authorization. `sanitized-fixture`, stale, unmapped, or partially verified
evidence cannot authorize causality.
The mapped entry-point range is one line and its UTF-16 character span must
exactly equal the expected entry-point text; an empty, shortened, or multiline
range is not exact evidence.
Variant citations retain parent build status. Compiler/generated citations
must close a current 64-hex registry evidence ID, registered virtual URI,
generated-document hash/range, provenance, and exact source mapping. The
compiler view hash must equal the generated snapshot hash. The registry-owned
mapping carries the exact generated-code range and source range as one pair;
both are single-line, have the same character span, and the generated citation
range must equal that generated side. Its `#line` directive must precede the
mapped generated line, report the mapped source line, and name a path alias of
the mapped source URI. The directive line itself is not generated-code
evidence. Adapter/Unity session identity and Variant/compiler build platform
must also agree when those corroborating branches are present.

### Conservative production projection

The production Workspace projector currently emits only evidence it can prove
from existing surfaces:

- the current, Workspace-validated Material Context; and
- an exact source Pass only when the Material's Shader revision hash matches
  the current source and Shader/SubShader/Pass analysis resolves one unique
  range.

The explanation graph projects only Material, Shader, selected Program, and
provenance identity from Material Context. Properties, textures, and keyword
inventories are deliberately excluded because they do not authorize this
question. The requested URI must be either the selected Shader itself or an
indexed include point whose Program matches that Material selection; another
Shader in the same Workspace is not relevant evidence.

It deliberately emits no `selection-decision` edge and does not synthesize
Shader Context, Variant, compiler, or generated-source evidence. Consequently,
the production path can present an observed Material Pass and an exact source
citation only when upstream Material evidence already contains
`selectedProgram`; it still refuses the causal explanation and lists the absent
evidence. The bundled Adapter does not currently author that program or the
decision, so its normal answer reports both as unavailable. A complete injected
graph is exercised only by deterministic fixtures until an Adapter capability
can author the missing observation, decision, and closed identity chain.

### Read-only presentation and freshness

**UnityShaderNav: Explain Current Pass** explicitly requests one answer for the
active ShaderLab or HLSL document. The client owns one session-scoped Webview
that separates observation, causal claim, missing evidence, contradictions,
exact citations, and execution policy. It starts no background explanation
request.

The Webview is read-only and scriptless. It has no local resource roots, no
network connection, and no edit or Apply control. The client validates the
bounded answer before rendering and escapes every displayed evidence value.
It tracks the requested URI and every source/revision URI cited by an accepted
answer, including each cited file's exact Unity `.meta` sidecar. It records all
document and filesystem mutations while a request is in flight, so an owning
Shader or sidecar first discovered in the response cannot race an include-file
request. An edit, external change, creation, or deletion of any cited source or
its sidecar, or a Material Context change, cancels in-flight work, removes the
answer, marks the panel stale, and requires the user to run the command again.
A new explicit request also cancels the previous one. Late answers from an
older request generation cannot replace the current state.

The current complete graphs remain deterministic test fixtures, not a
production capability. Before any future Adapter, Shader Context, Variant, or
compiler provider is wired into the production projector, that integration
must define one generation/freshness contract and notify the client when any
non-source evidence in a displayed answer becomes stale. A provider cannot
unlock `supported` merely by supplying a structurally valid graph.

### No edits in version 1

Version 1 always returns an empty `suggestedEdits` tuple, and the client rejects
any non-empty value. The protocol deliberately reserves no future Apply token
until a trusted registry can verify all of:

1. an explicitly accepted preview bound to its source revision;
2. passed compiler verification with provenance; and
3. passed test verification with a suite and result identity.

These requirements are a future design constraint, not a type-level trust claim
or a version 1 edit feature.

## Non-goals

- General natural-language Shader questions or repository chat.
- Inferring Unity selection behavior from source shape, Material names,
  compiler output, generated text, or whichever evidence is nearby.
- Calling an external or local language model to complete evidence.
- Suggesting, previewing, applying, or automatically validating source edits in
  version 1.
- Persisting answers, evidence graphs, or Webview state, or emitting telemetry.

## Consequences

- The current production answer reports exactly which observation and causal
  facts are unavailable. When a future Adapter authors `selectedProgram`, the
  observation can appear without weakening the independent causal refusal.
- Adding causal support requires a versioned Adapter capability that authors
  the selection decision and actual rule rationale, preserves the complete
  identity chain, and participates in unified evidence invalidation; changing
  prose or adding a model cannot unlock it.
- Tests can prove deterministic citation, missing-evidence, contradiction, and
  refusal behavior without a Unity Editor, while production projection tests
  separately prove that unavailable evidence is never manufactured.
- Any future edit workflow must be reviewed as a separate capability and pass
  the accepted-preview, compiler, and test gates documented by this decision;
  version 1 intentionally encodes no edit or Apply authority.
