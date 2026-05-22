# Plan 04 Review Fixes

Source review: `docs/superpowers/plans/plan04review.md`

## Fixes Applied

### P1: Case 8 parameter F12 coverage

- Added `server/tests/index/integration.test.ts` coverage for a real `indexFile()` result resolving a parameter usage back to the parameter declaration.
- Added `tests/integration/client/definition.test.ts` test-electron coverage for F12 on the `v` parameter usage in `test.hlsl`.

Red/green evidence:
- Initial focused run failed because the expected parameter start column was guessed as 20 while the collector correctly reports 19.
- After correcting the test to the real source range, focused vitest passed.

### P2: Duplicate and stale document indexing

- Added `server/tests/handlers/documents.test.ts` coverage for one index operation per open.
- Added stale-close coverage where a document is opened and immediately closed while async indexing is in flight.
- Changed `registerDocuments()` to index via `onDidChangeContent` only. `TextDocuments.listen()` already emits change-content for open events.
- Added live-uri and document-version guards so async indexing results are ignored after close or after a newer document version supersedes them.

Red/green evidence:
- Focused test run first failed with duplicate logs and stale store resurrection.
- After the guard change, `npx vitest run server/tests/handlers/documents.test.ts server/tests/index/integration.test.ts` passed: 2 files / 5 tests.
