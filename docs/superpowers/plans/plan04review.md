# Plan 04 Code Review

Review date: 2026-05-22
Reviewed range: `b4519cf..c9de2ec`

## Findings

### P1: Acceptance Case 8 is not covered end-to-end

File: `unity-shader-nav/tests/integration/client/definition.test.ts`

The Plan 04 acceptance list requires Case 8: F12 on a function parameter identifier should jump to the parameter declaration. Current coverage proves `.hlsl` function call F12 and multi-pass `.shader` multi-candidate F12, while `server/tests/index/symbolResolver.test.ts` uses a synthetic `FileIndex` for parameter shadowing. That does not prove the actual collector + document sync + LSP definition path handles parameter references.

Required fix: add an in-process and/or test-electron F12 case using a real indexed document where a parameter use resolves to the parameter declaration.

### P2: Document open triggers duplicate reindex and can leave stale indexes after close

File: `unity-shader-nav/server/src/handlers/documents.ts`

`TextDocuments.listen()` fires both `onDidOpen` and `onDidChangeContent` for an open event. Registering `reindex()` on both events indexes the same document twice on open. More importantly, `reindex()` awaits `indexFile()` and then unconditionally `store.set()`s; if a document is closed while indexing is still in flight, the close handler deletes the store entry, then the stale async reindex can set it back.

Required fix: avoid duplicate open indexing and guard async `store.set()` so closed documents are not resurrected.

## Positive Checks

- Definition capability is advertised while preserving lazy `getConnection()`.
- `definition.ts` stays a protocol adapter and keeps resolver logic out of the handler.
- Multi-candidate global result path is exercised by test-electron.
- Proximity tie-break has focused unit coverage.
