# Two-phase Cross-asset Shader Property Rename

## Status

Accepted — 2026-07-24 by
[#96](https://github.com/YukiagoTpf/UnityShaderNav/issues/96).

## Context

A ShaderLab Property name can be repeated in one `.shader` source contract,
proven C# `Shader.PropertyToID`, `Material`, or `MaterialPropertyBlock` calls,
and serialized Material assets. Standard LSP Rename returns a `WorkspaceEdit`;
it cannot transactionally update Unity assets through the Editor Adapter, and
VS Code applies the returned source edit only after the language-server request
has completed.

Applying source edits first can leave Material assets stale when the Adapter
fails. Applying Material changes first can leave assets ahead of source when
VS Code rejects or cancels the edit. Treating either result as success creates
a partially renamed contract.

## Decision

Keep standard F2 Rename conservative and source-local. Add an explicit
**Preview Safe Cross-asset Shader Property Rename** command for the larger
operation.

The preview is recomputed from one published Shader revision, exact current C#
source, complete Material asset evidence, and Adapter provenance. It groups
mechanical edits into Shader/HLSL source, proven C# source, and serialized
Material assets. Dynamic or name-only C# evidence, stale source, unavailable
asset scope, Package assets, ambiguous Property contracts, and unavailable
transactional Adapter support are blockers. Runtime-created Materials and
pre-existing serialized type drift remain visible manual follow-up.

Every preview receives a SHA-256 identity over its edits, blockers, source
revisions, Material revision, and provenance. Apply recomputes the plan and
refuses it when the identity changed.

### Transaction sequence

1. The Adapter prepares revision-checked Material updates without committing.
2. The client rechecks the exact old source text and applies all Shader and C#
   edits as one VS Code `WorkspaceEdit`.
3. If VS Code rejects or cancels the edit, the server rolls back the prepared
   Material transaction.
4. If source succeeds, the Adapter commits.
5. If commit fails, the Adapter rolls back every partial asset mutation and
   the client applies the inverse source edit derived from the preview's exact
   old text.

Prepared transactions expire after two minutes and roll back. Workspace
disposal also rolls back every prepared transaction. Adapter reconnects
invalidate prepared transactions through the existing
[ADR-0008](0008-unity-editor-adapter-lifecycle-and-trust-model.md) connection
identity. Finish is idempotent for the same transaction ID so a lost response
can be retried without committing twice or guessing whether source rollback is
safe.

`Shader.PropertyToID` flows retain the constant string origin; generated
numeric IDs are never a source identity. A derived Set/Get call does not itself
receive a text edit unless its proven range contains the exact Property name.

## Consequences

- Users see the complete evidence boundary before any mutation.
- Source and Material updates either commit together or both receive an
  explicit rollback attempt; conflict and rollback failure are never reported
  as success.
- The operation requires complete Adapter evidence. It does not guess when the
  Adapter, current C# source, or Material asset scope is unavailable.
- UnityShaderNav still registers no C# language provider. The explicit command
  edits only Adapter-proven Shader Property name tokens.
- Standard F2 Rename remains fast and source-local; the cross-asset command is
  intentionally explicit because it has external transactional effects.
