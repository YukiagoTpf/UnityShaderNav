# Issue 13 Document Highlight Fix Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development to implement this plan task-by-task.

**GitHub Issue:** https://github.com/YukiagoTpf/UnityShaderNav/issues/13

**Goal:** Add broad current-document symbol highlighting through LSP `textDocument/documentHighlight`.

**Diagnosis:** The server currently advertises definitions, references, and document symbols, but never advertises or registers `documentHighlightProvider`. Existing definition/reference code already has most of the hard symbol resolution behavior: `wordAt()`, `memberAccessAt()`, `resolveReferenceTargets()`, include-chain visibility, scoped local filtering, global kind narrowing, and receiver-typed struct member filtering. The fix should reuse that behavior and restrict output to the current document.

**Architecture:** Add a document highlight handler that shares reference-target selection rules with the references handler, then maps same-document declarations/references to `DocumentHighlight` ranges. Start with `DocumentHighlightKind.Text` only; do not attempt Read/Write classification until assignment detection is reliable.

**Tech Stack:** TypeScript, vscode-languageserver, vitest, existing `IndexStore` / `GlobalSymbolIndex` / `GlobalReferenceIndex`.

---

## Task 1: Advertise And Register Document Highlight

**Files:**
- Modify: `unity-shader-nav/server/src/connection.ts`
- Modify: `unity-shader-nav/server/src/server.ts`
- Create: `unity-shader-nav/server/src/handlers/referenceMatching.ts`
- Modify: `unity-shader-nav/server/src/handlers/references.ts`
- Create: `unity-shader-nav/server/src/handlers/documentHighlight.ts`
- Modify: `unity-shader-nav/server/tests/handshake.test.ts`
- Create: `unity-shader-nav/server/tests/handlers/documentHighlight.test.ts`

**Steps:**

1. Add a RED handshake assertion that `createInitializeResult().capabilities.documentHighlightProvider` is `true`.
2. Create a minimal handler test harness that captures `connection.onDocumentHighlight`.
3. Extract shared reference matching helpers from `references.ts` into `handlers/referenceMatching.ts`:
   - `sameTarget`
   - `symbolToTarget`
   - scoped/member/global target classifiers
   - compatible reference context checks
   - `narrowGlobalTargetsForOccurrence`
   - range/location uniqueness helpers
4. Update `references.ts` to consume the shared helpers without changing behavior.
5. Implement `documentHighlightProvider: true` in `createInitializeResult()`.
6. Register `registerDocumentHighlightHandler(connection, documents, manager, suspender)` from `server.ts`.
7. Create a placeholder handler that resolves workspace/document/index and reindexes the open document on a store miss, matching definition/document-symbol behavior.
8. Add a RED/GREEN test for store-miss live-document reindexing.
9. Run:
   - from `unity-shader-nav/`: `npm run test -w @unity-shader-nav/server -- --run tests/handshake.test.ts tests/handlers/documentHighlight.test.ts tests/handlers/references.test.ts`
10. Commit:
   - `feat(issue-13): register document highlight provider`

## Task 2: Highlight Locals, Parameters, Functions, Struct Types, And Macros

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/documentHighlight.ts`
- Modify: `unity-shader-nav/server/tests/handlers/documentHighlight.test.ts`

**Steps:**

1. Add RED handler tests for:
   - local variable declaration plus same-scope usages, excluding a shadowed local in another scope.
   - function declaration plus same-document call references.
   - struct declaration plus same-document type references.
   - macro declaration plus same-document macro call/identifier references.
   - automatic-highlight context rejection for comments, strings, ShaderLab `Properties` / tags, and valid `.shader` HLSLPROGRAM blocks.
2. Implement same-document highlighting by reusing current references semantics:
   - collect visible URI keys for the request document.
   - resolve active targets with `resolveReferenceTargets()`.
   - include matching declarations from `workspace.global.lookup(queryName)` only when `symbol.location.uri === requestUri`.
   - include matching references from the current file's `index.references` only when they resolve to the same active target.
   - preserve existing local/parameter scope filtering.
   - preserve global kind-aware filtering so a function call does not highlight same-name structs or locals.
   - call `isGenericDefinitionContext()` before resolving a token, so automatic highlights stay out of comments, strings, and non-HLSL ShaderLab contexts while still working inside HLSLPROGRAM blocks.
3. Return unique `DocumentHighlight` entries with `kind: DocumentHighlightKind.Text`.
4. Run:
   - from `unity-shader-nav/`: `npm run test -w @unity-shader-nav/server -- --run tests/handlers/documentHighlight.test.ts`
5. Commit:
   - `feat(issue-13): highlight current document symbols`

## Task 3: Highlight Receiver-Typed Struct Members

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/documentHighlight.ts`
- Modify: `unity-shader-nav/server/tests/handlers/documentHighlight.test.ts`

**Steps:**

1. Add RED tests for:
   - `inputData.positionWS` highlighting only `InputData.positionWS` references.
   - `i.positionWS` / `Varyings.positionWS` staying separate from `InputData.positionWS`.
   - a `.shader` HLSLPROGRAM fixture with Unity struct macros still producing member highlights after indexing.
   - unresolved member receiver behavior. Prefer conservative `null`/empty highlights for unresolved receivers unless existing reference resolver can prove a target; do not broad-highlight same-name members on an unresolved receiver.
2. Use `memberAccessAt()` and `resolveReferenceTargetsForMemberReference()` to filter member references by receiver-inferred parent type.
3. Include struct member declaration highlight only for the resolved parent type.
4. Keep unresolved member access conservative: if receiver type cannot be resolved, return no highlights for that member access.
5. Run:
   - from `unity-shader-nav/`: `npm run test -w @unity-shader-nav/server -- --run tests/handlers/documentHighlight.test.ts`
6. Commit:
   - `feat(issue-13): highlight typed struct members`

## Task 4: Verification And Issue Update

**Files:**
- Modify: `docs/superpowers/plans/issue-13-document-highlight-fix.md`

**Steps:**

1. Run focused server tests:
   - from `unity-shader-nav/`: `npm run test -w @unity-shader-nav/server -- --run tests/handlers/documentHighlight.test.ts tests/handlers/references.test.ts tests/handlers/definition.test.ts tests/handshake.test.ts`
2. Run full server tests:
   - from `unity-shader-nav/`: `npm run test -w @unity-shader-nav/server`
3. Run build:
   - from `unity-shader-nav/`: `npm run build`
4. Request codereview subagent over the implementation range.
5. Fix Critical/Important findings, update this plan with review/fix notes, and commit those fixes separately.
6. Add a GitHub issue comment summarizing:
   - root cause.
   - implementation scope.
   - verification commands and results.
   - residual manual verification request for the user.
7. Do not close the issue; leave it for user validation.
8. Commit documentation/status update if the plan review or code review notes changed this file:
   - `docs(issue-13): record document highlight verification`

---

## Plan Review Notes

### 2026-05-25 planreviewer pass 1

Reviewer: Meitner (`019e5d31-9ba2-7632-8bbd-99dd88a42877`)

Conclusion: Changes requested.

Applied changes:

- Added automatic-highlight context rejection using `isGenericDefinitionContext()` and tests for comments, strings, ShaderLab non-HLSL areas, and valid HLSLPROGRAM blocks.
- Added explicit extraction of shared reference matching helpers from `references.ts`.
- Added open-document store-miss reindexing requirement and regression test.
- Changed unresolved member behavior to conservative empty highlights.
- Clarified that commands run from `unity-shader-nav/`.

### 2026-05-25 codereview pass

Reviewer: Hume (`019e5d4b-4d42-72f1-b155-e88f6831a0e5`)

Range: `8f73fa6b440776e74009e60c4ee913e5d5f3609b..8ae2ef9707c0ca74ea76c98c08d6d2edc7b5ef49`

Conclusion: Approved. No Critical, Important, or Minor findings.

Verification before review:

- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/documentHighlight.test.ts tests/handlers/references.test.ts tests/handlers/definition.test.ts tests/handshake.test.ts`: 4 files / 53 tests passed.
- `npm run test -w @unity-shader-nav/server`: 47 files / 302 tests passed.
- `npm run build`: passed.

Implementation notes:

- Added `textDocument/documentHighlight` capability and handler registration.
- Extracted shared reference matching helpers so document highlights and Find References use the same target/context filtering rules.
- Added current-document symbol highlights for locals, parameters, functions, struct types, macros, and receiver-typed struct members.
- Added context guards for comments, strings, and non-HLSL ShaderLab areas while preserving HLSLPROGRAM highlights.
- Kept unresolved member receivers conservative by returning no highlight instead of broad same-name member highlights.

> Note: 2026-05-25 manual validation showed `inputData.positionWS` could still return no highlight when the receiver variable is known locally but the external `InputData.positionWS` member declaration is not currently indexed. The implementation may deviate from the pure "unresolved member => no highlights" rule by adding a narrower fallback: if the receiver resolves to the same local/parameter/variable target, highlight same-document member references with that same receiver target, while still avoiding broad same-name member highlights such as mixing `inputData.positionWS` with `i.positionWS`.

> Note: 2026-05-25 follow-up manual validation clarified that issue #13 also expects always-on editor semantic coloring, not only cursor-driven `textDocument/documentHighlight` occurrences. The follow-up therefore adds LSP semantic tokens for struct types, variables, parameters, members, functions, and macros so theme highlighting can color constructs such as `InputData`, `inputData.positionWS`, and `o.fogCoord` without requiring the cursor to be on the symbol.
