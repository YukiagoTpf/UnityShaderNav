# Plan 04 Review Fixes

Source review: `docs/superpowers/plans/plan04review.md`

## Fixes Applied

### P1: Case 8 parameter F12 coverage

- Added `server/tests/index/integration.test.ts` coverage for a real `indexFile()` result resolving a parameter usage back to the parameter declaration.
- Added `tests/integration/client/definition.test.ts` test-electron coverage for F12 on the `v` parameter usage in `test.hlsl`.

Red/green evidence:
- Initial focused run failed because the expected parameter start column was guessed as 20 while the collector correctly reports 19.
- After correcting the test to the real source range, focused vitest passed.
- Final test-electron verification caught that the `.hlsl` fixture's `v` usage cursor was placed on `*` instead of `v`. The test now places the cursor on character 33 and asserts the parameter declaration starts at character 21.

### P2: Duplicate and stale document indexing

- Added `server/tests/handlers/documents.test.ts` coverage for one index operation per open.
- Added stale-close coverage where a document is opened and immediately closed while async indexing is in flight.
- Changed `registerDocuments()` to index via `onDidChangeContent` only. `TextDocuments.listen()` already emits change-content for open events.
- Added live-uri and document-version guards so async indexing results are ignored after close or after a newer document version supersedes them.

Red/green evidence:
- Focused test run first failed with duplicate logs and stale store resurrection.
- After the guard change, `npx vitest run server/tests/handlers/documents.test.ts server/tests/index/integration.test.ts` passed: 2 files / 5 tests.

### P3: Reproducible Plan04 Task 8 verification command

- Verified the independent review finding: `npm test -w unity-shader-nav -- --grep "F12 single-file"` is stale because the `unity-shader-nav` workspace is the VSCode client package and has no `test` script.
- Updated `docs/superpowers/plans/2026-05-22-04-single-file-definition.md` Task 8 Step 4 to preserve the deviation as a `> Note:` and use the reproducible root `npm test` command.

Verification:
- `npm test -w unity-shader-nav -- --grep "F12 single-file"` fails as documented with `Missing script: "test"`.
- `npm test` passes and executes the Electron `F12 single-file` suite.
