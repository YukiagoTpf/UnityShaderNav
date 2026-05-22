# Plan 04 Independent Code Review

Review date: 2026-05-22
Reviewed range: `b4519cf..c18ad49`
Reviewer stance: independent review of the current code, treating the earlier self-authored review/fix docs as untrusted.

## Findings

### P3: Focused Plan04 verification command is not reproducible

File: `docs/superpowers/plans/2026-05-22-04-single-file-definition.md:737`

The Task 8 focused verification command is:

```bash
npm test -w unity-shader-nav -- --grep "F12 single-file"
```

Run from the actual monorepo root (`unity-shader-nav/`), this fails because the `unity-shader-nav` workspace is the VSCode client package and it has no `test` script. This does not invalidate the implementation acceptance, because root `npm test` does compile and execute the Electron integration tests, including the `F12 single-file` suite. It is still a plan replay defect: a future agent following the plan literally will see a failure where the plan says `预期：PASS`.

Suggested follow-up: update the plan command or add a `> Note:` explaining that the acceptance gate is root `npm test`, and that the old focused workspace command is stale.

## No Blocking Findings

I did not find blocking Plan04 implementation issues in the current HEAD.

- Case 1 is covered by the Electron `.shader` multi-pass test returning two same-file `vert` candidates.
- Case 8 is covered both in-process and through Electron by resolving a real parameter usage back to its parameter declaration.
- `registerDocuments()` now indexes through the `TextDocuments` content-change path, avoids duplicate open indexing, and guards async index writes with both live-uri and version checks.
- `registerDefinitionHandler()` stays a protocol adapter: it reads the live document/store entry, extracts the identifier, delegates to `resolveDefinition()`, and maps links to LSP `LocationLink`s.
- `resolveDefinition()` applies scoped parameter/local precedence, then proximity tie-break, then returns all global candidates for Peek-style multi-candidate results.
- The Electron suite glob was broadened to `tests/out/**/*.test.js`, and `tests/tsconfig.json` includes `integration/**/*.ts`, so the Plan04 integration tests are actually built and executed.

## Residual Risks

- `wordAt()` intentionally only resolves when the cursor position is on an identifier character. That matches the Plan04 test note, but it means positions immediately after an identifier return `null`.
- Save events do not trigger a separate reindex path. This is acceptable for current live document sync because open/change content already maintains the store, but it is worth remembering when Plan08/09 add broader lifecycle and persistence behavior.
- Member/type names are included in the generic global fallback path. Plan04 acceptance focuses on same-file functions and parameters; Plan11/13 should revisit more precise member/type resolution.

## Verification

Commands run from `F:\Project\UnityShaderNav\unity-shader-nav` unless noted:

```bash
npx vitest run server/tests/index/wordAt.test.ts server/tests/index/symbolResolver.test.ts server/tests/index/integration.test.ts server/tests/handlers/definition.test.ts server/tests/handlers/documents.test.ts
```

Result: PASS, 5 files / 13 tests.

```bash
npm test
```

Result: PASS. Electron: 6 passing, including `F12 single-file` call, parameter, and multi-pass `.shader` tests. Server vitest: 14 files / 58 tests.

```bash
npm test -w unity-shader-nav -- --grep "F12 single-file"
```

Result: FAIL as a plan-command issue, not as an implementation failure: `workspace unity-shader-nav@0.0.1` has no `test` script.
