# Overall Consistency Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Close the remaining project-wide consistency gaps before a VSIX release: packaged runtime closure, reference semantics, workspace/cache lifecycle, lexical preprocessing, and Electron/release-chain stability.

**Architecture:** Keep fixes thematic rather than tied to Plan 01-13 history. Reuse the existing LSP handler shape, `WorkspaceManager`/`Workspace` ownership boundaries, `IndexStore`/`GlobalSymbolIndex`/`GlobalReferenceIndex`, and current test split: server vitest for semantics, test-electron for VS Code behavior, package-layout tests for VSIX/runtime checks. High-risk behavior changes start with focused failing tests, then the minimal implementation, then root verification.

**Tech Stack:** TypeScript, VS Code extension API, `vscode-languageclient`/`vscode-languageserver`, tree-sitter HLSL via `web-tree-sitter`, Vitest, Mocha + `@vscode/test-electron`, esbuild, npm workspaces, VSIX packaging through `vsce`.

**Risk Strategy:** P1 tasks are release blockers and must be completed before VSIX handoff. P2 tasks are recommended before broader dogfooding because they affect correctness or stability under common workflows. P3 tasks are explicitly deferrable unless the release scope expands. Each task is one commit; if reality diverges from this plan, add a `> Note:` under the affected task before changing implementation.

---

## Priority Map

P1 mandatory before release:
- VSIX runtime dependency closure for `web-tree-sitter`.
- Clean/build/package ordering so VSIX cannot include missing or stale `out/`.
- Find References canonical target semantics so locals, params, members, and globals match F12 behavior.

P2 recommended before dogfooding:
- Self-contained package-layout/VSIX content tests.
- Shared path containment helper.
- Lazy workspace readiness and folder add/remove suspension.
- Live open-document version guard for rebuild/file-watcher/settings reindex.
- Cache manifest schema guard.
- Include-path Find References.
- Generic F12 lexical/context gate.
- Block-comment-aware `#pragma` scanner.
- README staging into VSIX.
- Resource-scoped settings manifest + multi-root E2E.
- test-electron suite isolation.

P3 deferred unless release scope changes:
- Runtime watch/dev script.
- Cross-process cache write hardening.
- Unity macro sentinel reference filtering.
- Clean stale compiled Electron tests.
- CI `.vscode-test/` cache.
- Large-project performance work, cache sharding/compression, chain lookup L3b/L4, expanded PackageManager forms, CG legacy declarations.

Recommended execution order:
1. Phase 0 P1 release safety.
2. Phase 1 P1 reference semantics.
3. Phase 2 P2 workspace/cache lifecycle.
4. Phase 3 P2 lexical/preprocessor consistency.
5. Phase 4 P2 Electron/release-chain hardening.
6. Phase 5 deferred P3/polish as separate follow-up work.

---

## Phase 0: Release/VSIX Closure Safety

Acceptance commands for this phase:
- `npm run clean`
- `npm run build`
- `npm test`
- From `unity-shader-nav/client`: `npx vsce package --no-dependencies --no-yarn`
- Inspect/unzip the generated `.vsix` and assert `extension/out/extension.js`, `extension/out/server/server.js`, `extension/out/grammars/tree-sitter-hlsl.wasm`, and the chosen `web-tree-sitter` runtime files exist.

### Task 0.1: Guarantee packaged runtime closure for `web-tree-sitter`

**Priority:** P1 mandatory.

**Files:**
- Modify: `unity-shader-nav/scripts/build.mjs`
- Modify: `unity-shader-nav/scripts/copy-server.mjs`
- Test: `unity-shader-nav/tests/client/package-layout.test.ts`
- Maybe inspect: `unity-shader-nav/client/package.json`

**Why:** `server/src/parser/hlsl/parser.ts` dynamically loads `web-tree-sitter`; the current test proves monorepo hoist resolution, not that a VSIX installed from `client/` can resolve the package when packaged with `--no-dependencies`.

**Steps:**
1. Add a failing package-layout test that creates or inspects a VSIX-like extension root and resolves `web-tree-sitter` from `client/out/server/server.js` without relying on the monorepo root `node_modules`.
2. Run `npm test -- --grep "packaged server layout"` is not valid at root; instead run `npm run build` then `npx tsc -p tests/tsconfig.json` and `node tests/out/runTest.js` if keeping this as a Mocha client test. For faster iteration, temporarily run the compiled test file through the Electron suite only if needed.
3. Update `scripts/build.mjs` and `scripts/copy-server.mjs` so the packaged extension contains the runtime dependency required by `createRequire(serverEntry).resolve('web-tree-sitter')`. Prefer copying only the necessary package runtime subtree under `client/out/server/node_modules/web-tree-sitter` or another location Node resolution can reach from `client/out/server/server.js`.
4. Keep `client/package.json` dependency declaration for `web-tree-sitter`; do not depend on npm installing dependencies during `vsce package --no-dependencies`.
5. Re-run the package-layout test and full build.

**Tests:**
- `npm run build`
- `npx tsc -p tests/tsconfig.json`
- `node tests/out/runTest.js`
- `npm test`

**Commit message:** `fix(release): include tree-sitter runtime in packaged extension`

### Task 0.2: Add a safe VSIX packaging script and stale-output guard

**Priority:** P1 mandatory.

**Files:**
- Modify: `unity-shader-nav/package.json`
- Modify: `unity-shader-nav/client/package.json`
- Create or modify: `unity-shader-nav/scripts/package-vsix.mjs`
- Test: `unity-shader-nav/tests/client/package-layout.test.ts`

**Why:** `client/package.json` points `main` at `out/extension.js`, but there is no `vscode:prepublish` or release command that guarantees clean/build happens before packaging. A stale `client/out` can produce a misleading VSIX.

**Steps:**
1. Add a failing test or script assertion that rejects packaging when `client/out/extension.js`, `client/out/server/server.js`, or `client/out/grammars/tree-sitter-hlsl.wasm` is missing or older than the relevant source/build inputs.
2. Add a root script such as `package:vsix` that runs `npm run clean && npm run build`, then runs `vsce package --no-dependencies --no-yarn` from `client/`.
3. Add `client/package.json` `vscode:prepublish` pointing to the same build path or a small guard script. Keep one canonical packaging command documented in scripts.
4. Make `scripts/package-vsix.mjs` unzip or list the `.vsix` and assert required files. Avoid relying on visual inspection as the only release gate.
5. Keep generated `.vsix` ignored or out of commits.

**Tests:**
- `npm run package:vsix`
- `npm test`

**Commit message:** `fix(release): build before packaging vsix`

### Task 0.3: Stage README and package metadata into the extension root

**Priority:** P2 recommended.

> Note: Follow-up review found that staging README only inside the root `package:vsix` wrapper does not cover direct `vsce package` runs from `client/`. The fix must make the client `vscode:prepublish` path prepare the extension root too, so the standard VSCE release path includes `extension/README.md`.

**Files:**
- Modify: `unity-shader-nav/scripts/package-vsix.mjs` or `unity-shader-nav/scripts/build.mjs`
- Modify: `unity-shader-nav/client/package.json`
- Test: `unity-shader-nav/tests/client/package-layout.test.ts`
- Maybe inspect: repo-root `README.md`

**Why:** The README currently lives at the repo root, while VSIX packaging runs from `client/`. Marketplace/package consumers should receive the extension README, and packaging tests should verify it.

**Steps:**
1. Add a failing package-layout assertion that the extension root used for packaging contains `README.md`.
2. Stage or copy the repo-root README into `client/` during packaging, or move to a canonical release-root strategy. Prefer staging during the package script to avoid duplicated docs drift.
3. If `client/.vscodeignore` excludes staged docs, update it narrowly.
4. Verify the generated VSIX includes `extension/README.md`.

**Tests:**
- `npm run package:vsix`
- `node tests/out/runTest.js`

**Commit message:** `fix(release): include readme in packaged extension`

---

## Phase 1: References Semantic Consistency

Acceptance commands for this phase:
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/references.test.ts tests/index/symbolResolver.test.ts tests/index/chainLookup.test.ts tests/parser/hlsl/collector.test.ts`
- `npm run build`
- `npm test`

### Task 1.1: Introduce a canonical reference target resolver

**Priority:** P1 mandatory.

**Files:**
- Create: `unity-shader-nav/server/src/index/referenceResolver.ts`
- Modify: `unity-shader-nav/server/src/index/index.ts`
- Test: `unity-shader-nav/server/tests/index/referenceResolver.test.ts`
- Inspect: `unity-shader-nav/server/src/index/symbolResolver.ts`
- Inspect: `unity-shader-nav/server/src/index/chainLookup.ts`
- Inspect: `unity-shader-nav/shared/src/symbols.ts`

**Why:** F12 resolves a scoped/canonical declaration, but Find References currently uses only `wordAt(...).text`. The fix needs a shared target concept before changing the handler.

**Steps:**
1. Write failing tests for:
   - local variable `value` inside one function does not target another function's local `value`;
   - parameter `uv` targets only references inside its `scopeRange`;
   - global function `Helper` targets global call references;
   - struct member `surface.positionWS` targets members with matching `parentType`.
2. Implement a small resolver that uses existing `resolveDefinition()` for generic words and `resolveMember()` for member accesses, then normalizes the result into canonical target records: `{ name, kind, uri, range, scopeRange?, parentType? }`.
3. Do not expand `ReferenceEntry` yet unless the tests prove existing metadata is insufficient. Prefer deriving filters from target symbol metadata already in `SymbolEntry`.
4. Export the resolver from `server/src/index/index.ts`.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/index/referenceResolver.test.ts`

**Commit message:** `fix(references): resolve canonical reference targets`

### Task 1.2: Filter same-file scoped references by canonical scope

**Priority:** P1 mandatory.

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/references.ts`
- Modify: `unity-shader-nav/server/src/index/referenceResolver.ts`
- Test: `unity-shader-nav/server/tests/handlers/references.test.ts`
- Maybe modify: `unity-shader-nav/shared/src/symbols.ts`
- Maybe modify: `unity-shader-nav/server/src/parser/hlsl/collector.ts`

**Why:** Local variables and parameters with the same name are common in shader code. Find References must not merge unrelated same-name local/parameter references.

**Steps:**
1. Add failing handler tests with two functions that both use `i` or `uv`; requesting references on one local/parameter should return only its declaration when `includeDeclaration=true` and references inside the same `scopeRange`.
2. If current `ReferenceEntry` lacks enough scope data for identifier references, extend it with optional `scopeRange` or `ownerSymbolRange` for local/parameter identifier references in `collector.ts`.
3. Update `registerReferencesHandler()` to resolve the canonical target first, then filter `workspace.globalRefs.lookup(name)` by target kind and scope.
4. Keep package filtering behavior from existing tests.
5. Preserve RequestSuspender behavior.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/references.test.ts tests/parser/hlsl/collector.test.ts`

**Commit message:** `fix(references): respect local and parameter scope`

### Task 1.3: Align member references with receiver type

**Priority:** P1 mandatory.

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/references.ts`
- Modify: `unity-shader-nav/server/src/index/referenceResolver.ts`
- Maybe modify: `unity-shader-nav/server/src/parser/hlsl/collector.ts`
- Test: `unity-shader-nav/server/tests/handlers/references.test.ts`
- Test: `unity-shader-nav/server/tests/index/referenceResolver.test.ts`

**Why:** F12 on `surface.positionWS` can use receiver type inference, but Find References for `positionWS` currently returns every same-name member reference.

**Steps:**
1. Add failing tests with two structs that both have `positionWS`; references on `Surface.positionWS` must not return `Other.positionWS`.
2. If member `ReferenceEntry` does not record receiver type, either infer receiver type during filtering using the source file index and reference position, or augment collection for member refs where type can be inferred safely.
3. Reuse `resolveMember()` semantics for the request position; do not introduce a separate member-definition algorithm.
4. Deduplicate declaration/reference locations by URI + range.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/references.test.ts tests/index/chainLookup.test.ts`

**Commit message:** `fix(references): filter member references by receiver type`

### Task 1.4: Keep global symbol references broad but kind-aware

**Priority:** P1 mandatory.

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/references.ts`
- Test: `unity-shader-nav/server/tests/handlers/references.test.ts`
- Maybe modify: `unity-shader-nav/server/src/index/referenceResolver.ts`

**Why:** Functions, macros, cbuffers, structs, and top-level variables can share names in malformed or generated shader code. Find References should include compatible references for the resolved target and avoid accidental local/member pollution.

**Steps:**
1. Add failing tests for a global function and a local variable with the same name; requesting references on the function returns call refs and the function declaration, not the local variable declaration/ref.
2. Add a macro symbol test where `#define SAMPLE_TEXTURE2D` references still work as macro/global references.
3. Define a compatibility table by target kind:
   - `function`: `call` and `pragma`;
   - `struct`: `type`;
   - `structMember`: handled by Task 1.3;
   - `macro`: identifier/call where collected as macro usage;
   - `variable`/`cbuffer`: identifier/member where appropriate.
4. Keep behavior conservative: if a target kind is ambiguous, prefer fewer references over name-only noise.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/references.test.ts tests/macros/integration.test.ts`

**Commit message:** `fix(references): filter global references by target kind`

### Task 1.5: Add include-path Find References branch

**Priority:** P2 recommended.

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/references.ts`
- Modify: `unity-shader-nav/server/src/parser/hlsl/fileIndexer.ts` if include reference normalization is needed
- Test: `unity-shader-nav/server/tests/handlers/references.test.ts`
- Test: `unity-shader-nav/tests/integration/client/find-references.test.ts`
- Inspect: `unity-shader-nav/server/src/handlers/definition.ts`
- Inspect: `unity-shader-nav/server/src/parser/include/lineScanner.ts`

**Why:** Include references are indexed with `context='include'`, but Shift+F12 uses `wordAt`, so a cursor inside `"Common.hlsl"` cannot query the full include path.

**Steps:**
1. Add a failing handler test that places the cursor inside an include path and expects all include references to the same resolved file.
2. Mirror the include branch in `definition.ts`: use `scanIncludes(fullText)` and `pathRange` before generic word lookup.
3. Resolve the include under the current workspace `includeCtx`, then compare include references by resolved target URI where possible, not by raw spelling only. This should merge `Assets/...`, relative, and package spellings when they point to the same file.
4. Add an Electron test only after the server handler behavior is green.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/references.test.ts tests/handlers/definition-include.test.ts`
- `npm test`

**Commit message:** `fix(references): support include path lookups`

---

## Phase 2: Workspace Lifecycle/Cache Consistency

Acceptance commands for this phase:
- `npm run test -w @unity-shader-nav/server -- --run tests/workspace tests/lifecycle tests/cache`
- `npm run build`
- `npm test`

### Task 2.1: Centralize path containment and case normalization

**Priority:** P2 recommended.

**Files:**
- Create: `unity-shader-nav/server/src/workspace/pathUtils.ts`
- Modify: `unity-shader-nav/server/src/workspace/workspaceManager.ts`
- Modify: `unity-shader-nav/server/src/workspace/workspace.ts`
- Test: `unity-shader-nav/server/tests/workspace/pathUtils.test.ts`
- Test: `unity-shader-nav/server/tests/workspace/workspaceManager.test.ts`

**Why:** `WorkspaceManager` currently has a local `containsPath()` that is case-sensitive on Windows, while `Workspace` has a separate case-normalizing `isWithinPath()`. Routing and package filtering should use one definition.

**Steps:**
1. Write failing tests for Windows-style case differences if the test can be platform-independent by injecting `win32` behavior into the helper.
2. Extract `normalizePathForComparison()` and `containsPath(root, candidate)` into `pathUtils.ts`.
3. Use the helper in `WorkspaceManager.workspaceFor()`, `Workspace.isInPackages()`, and `Workspace.shouldRestoreCachedFile()`.
4. Keep path resolution using absolute paths and `path.relative`; do not fall back to prefix string matching.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/workspace/pathUtils.test.ts tests/workspace/workspaceManager.test.ts tests/workspace/workspace.test.ts`

**Commit message:** `fix(workspace): share path containment semantics`

### Task 2.2: Add workspace readiness for lazy and added folders

**Priority:** P2 recommended.

**Files:**
- Modify: `unity-shader-nav/server/src/workspace/workspaceManager.ts`
- Modify: `unity-shader-nav/server/src/workspace/workspace.ts` if a `ready` promise belongs on Workspace
- Modify: LSP handlers that call `workspaceForOrCreateFile()` only if type contracts change
- Test: `unity-shader-nav/server/tests/workspace/workspaceManager.test.ts`
- Test: `unity-shader-nav/server/tests/handlers/definition.test.ts`
- Test: `unity-shader-nav/server/tests/handlers/references.test.ts`

**Why:** `addFolder()` sets `byFolder` before `workspace.bootstrap()` completes. A handler racing with bootstrap can observe a half-initialized workspace.

**Steps:**
1. Write a failing `workspaceManager` test where `Workspace.bootstrap()` is delayed and concurrent `workspaceForOrCreateFile()` calls await the same ready promise instead of returning an unbootstrapped workspace.
2. Store workspace records as `{ workspace, ready }` or add `workspace.ready`.
3. Make `workspaceForOrCreateFile()` await readiness before returning.
4. Ensure duplicate lazy creation for the same folder coalesces into one bootstrap.
5. Keep `list()` semantics clear: either return only ready workspaces, or document and test that rebuild paths await all ready promises before use.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/workspace/workspaceManager.test.ts tests/handlers/definition.test.ts tests/handlers/references.test.ts`

**Commit message:** `fix(workspace): await lazy workspace bootstrap`

### Task 2.3: Suspend requests across folder add/remove lifecycle changes

**Priority:** P2 recommended.

**Files:**
- Modify: `unity-shader-nav/server/src/lifecycle/fileWatcher.ts` or server workspace-folder notification wiring
- Modify: `unity-shader-nav/server/src/server.ts`
- Test: `unity-shader-nav/server/tests/lifecycle/fileWatcher.test.ts`
- Test: `unity-shader-nav/server/tests/workspace/workspaceManager.test.ts`

**Why:** Rebuilds are already suspended, but workspace folder add/remove can change routing and indexes while handlers run.

**Steps:**
1. Find the current `workspace/didChangeWorkspaceFolders` handling in `server/src/server.ts`.
2. Add a failing test proving folder add/remove calls `suspender.suspend()` before bootstrap/remove and `release()` after completion.
3. Wrap add/remove with the same `RequestSuspender` used by definition, document symbols, and references.
4. Ensure remove persists or drops workspace state intentionally before deleting from `WorkspaceManager`.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/lifecycle/fileWatcher.test.ts tests/workspace/workspaceManager.test.ts`

**Commit message:** `fix(workspace): suspend requests during folder changes`

### Task 2.4: Reuse live document version guards during rebuild overlay reindex

**Priority:** P2 recommended.

**Files:**
- Modify: `unity-shader-nav/server/src/lifecycle/rebuild.ts`
- Maybe modify: `unity-shader-nav/server/src/handlers/documents.ts`
- Test: `unity-shader-nav/server/tests/lifecycle/rebuild.test.ts`
- Test: `unity-shader-nav/server/tests/handlers/documents.test.ts`

**Why:** Document change handling has a version/close guard, but `reindexOpenDocuments()` calls `workspace.reindex(uri, text)` directly after rebuild. A document that changes or closes during rebuild can write stale overlay data.

**Steps:**
1. Add a failing test where `getOpenDocuments()` returns snapshots with version data and one document becomes stale before `workspace.reindex()` stores the index.
2. Extend `OpenDocumentSnapshot` with `version` and `isCurrent()` or pass a `shouldStore` callback like the document handler already uses.
3. Update `reindexOpenDocuments()` so rebuild/file-watcher/settings open-doc reindex uses the same guard path as document changes.
4. Keep the "restore open documents before release" ordering from existing tests.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/lifecycle/rebuild.test.ts tests/handlers/documents.test.ts tests/lifecycle/fileWatcher.test.ts`

**Commit message:** `fix(lifecycle): guard open document reindex after rebuild`

### Task 2.5: Validate cache manifest schema at runtime

**Priority:** P2 recommended.

**Files:**
- Modify: `unity-shader-nav/server/src/cache/cacheStore.ts`
- Maybe create: `unity-shader-nav/server/src/cache/schema.ts`
- Test: `unity-shader-nav/server/tests/cache/cacheStore.test.ts`
- Test: `unity-shader-nav/server/tests/workspace/workspace.test.ts`

**Why:** `CacheStore.load()` validates version/fingerprint but casts arbitrary JSON to `CacheManifest`. Bad records can throw later or poison indexes. The desired behavior is: bad manifest returns null, bad file records are skipped, and the workspace falls back to full scan.

**Steps:**
1. Add failing tests for missing `files`, non-array `files`, malformed file record, malformed `index.symbols`, malformed `location.range`, and malformed `fingerprint`.
2. Implement a small runtime type guard for `CacheManifest` and `CachedFile`; keep it local and explicit rather than adding a schema dependency unless the project already uses one.
3. Return `null` for invalid manifest envelope. For invalid individual file records, either filter them in `CacheStore.load()` or in `Workspace.bootstrapFromCache()`; document the chosen boundary in a short code comment.
4. Ensure valid existing manifest tests still pass.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/cache/cacheStore.test.ts tests/workspace/workspace.test.ts tests/cache/coldStart.test.ts`

**Commit message:** `fix(cache): validate persisted manifest schema`

---

## Phase 3: Lexical/Preprocessor Consistency

Acceptance commands for this phase:
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/definition.test.ts tests/handlers/definition-include.test.ts tests/parser/hlsl/fileIndexer.test.ts tests/macros`
- `npm run build`
- `npm test`

### Task 3.1: Gate generic F12 by lexical and ShaderLab HLSL context

**Priority:** P2 recommended.

**Files:**
- Modify: `unity-shader-nav/server/src/handlers/definition.ts`
- Maybe create: `unity-shader-nav/server/src/parser/lexical/context.ts`
- Test: `unity-shader-nav/server/tests/handlers/definition.test.ts`
- Test: `unity-shader-nav/server/tests/parser/shaderlab/blockScanner.test.ts`

**Why:** Include-path F12 is intentionally available in directives, but generic symbol F12 should not resolve identifiers inside comments, strings, or ShaderLab non-HLSL regions.

**Steps:**
1. Add failing tests for:
   - `.hlsl` line comment and block comment identifiers return null;
   - string literal identifiers return null;
   - `.shader` `Properties` or ShaderLab tags with same-name tokens return null;
   - `.shader` HLSLPROGRAM block still resolves normally.
2. Implement a lexical gate before `wordAt()` generic resolution. Reuse existing scanners where possible: `scanBlocks()` for `.shader` HLSL regions and a comment/string scanner derived from existing sanitizer/preproc behavior.
3. Do not block the include branch; it already uses `scanIncludes()` and path ranges.
4. Keep member access and generic word behavior unchanged inside valid HLSL contexts.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/definition.test.ts tests/handlers/definition-include.test.ts`

**Commit message:** `fix(definition): suppress generic jumps outside hlsl code`

### Task 3.2: Make pragma scanning block-comment aware

**Priority:** P2 recommended.

**Files:**
- Modify: `unity-shader-nav/server/src/macros/matcher.ts`
- Modify: `unity-shader-nav/server/src/parser/hlsl/fileIndexer.ts`
- Test: `unity-shader-nav/server/tests/macros/matcher.test.ts`
- Test: `unity-shader-nav/server/tests/macros/integration.test.ts`
- Test: `unity-shader-nav/server/tests/parser/hlsl/fileIndexer.test.ts`

**Why:** Include and define scanners ignore multi-line block comments, while `matchPragmaLine()` only strips `//`. Commented-out pragmas can become references and Outline entries.

**Steps:**
1. Add failing tests for `/* #pragma vertex Disabled */` and multi-line block comments around pragma lines in `.hlsl` and `.shader` HLSL blocks.
2. Replace line-local pragma scanning with a block-comment-aware scanner that carries comment state across lines.
3. Keep `#pragma vertex vert`, `#pragma fragment frag`, and `.compute #pragma kernel CSMain` behavior.
4. If the scanner lives outside `matcher.ts`, keep `matchPragmaLine()` as a pure single-line helper only for already-sanitized lines.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/macros/matcher.test.ts tests/macros/integration.test.ts tests/parser/hlsl/fileIndexer.test.ts`

**Commit message:** `fix(macros): ignore pragmas inside block comments`

### Task 3.3: Filter Unity macro sentinel reference noise

**Priority:** P3 deferred, useful if Find References output remains noisy.

**Files:**
- Modify: `unity-shader-nav/server/src/macros/index.ts` or create `unity-shader-nav/server/src/macros/sentinels.ts`
- Modify: `unity-shader-nav/server/src/parser/hlsl/collector.ts`
- Test: `unity-shader-nav/server/tests/macros/integration.test.ts`
- Fixtures: `unity-shader-nav/server/tests/macros/fixtures/cbuffer-macro.hlsl`
- Fixtures: `unity-shader-nav/server/tests/macros/fixtures/instanced-prop.hlsl`

**Why:** `CBUFFER_END`, `UNITY_INSTANCING_BUFFER_END`, and similar sentinel macros should not pollute user-facing Find References.

**Steps:**
1. Add failing tests showing sentinel names are not emitted as `ReferenceEntry`, while meaningful captured symbols such as `UnityPerMaterial` remain indexed.
2. Add a small ignored macro table for known end/sentinel macros.
3. Apply the filter at collection time so all consumers benefit.
4. Keep custom declaration macro matching unaffected.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/macros/integration.test.ts tests/parser/hlsl/collector.test.ts`

**Commit message:** `fix(macros): filter unity sentinel references`

### Task 3.4: Add CG legacy declaration indexing

**Priority:** P3 deferred unless legacy `.cginc` support becomes release-critical.

**Files:**
- Modify: `unity-shader-nav/server/src/parser/hlsl/collector.ts`
- Test: `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts`
- Test fixture: `unity-shader-nav/server/tests/parser/shaderlab/fixtures/cg-legacy.shader`
- Maybe modify: `unity-shader-nav/server/tests/macros/integration.test.ts`

**Why:** `sampler2D _MainTex;` and `fixed4 _Color;` are ordinary CG/HLSL declarations and should become variable symbols, but this was deferred during macro pattern work.

**Steps:**
1. Add failing tests for `sampler2D _MainTex;`, `fixed4 _Color;`, and equivalent declarations inside `.shader` CGPROGRAM blocks.
2. Teach collector declaration handling to treat CG primitive/type aliases as declarations with `kind='variable'` and `declaredType`.
3. Avoid reclassifying function return types or struct fields incorrectly.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/parser/hlsl/collector.test.ts tests/parser/hlsl/fileIndexer.test.ts`

**Commit message:** `fix(index): index legacy cg declarations`

---

## Phase 4: Test-Electron/Release-Chain Hardening

Acceptance commands for this phase:
- `npm run clean`
- `npm test` repeated at least twice on Windows
- `node tests/out/runTest.js`
- `npm run test -w @unity-shader-nav/server`

### Task 4.1: Isolate Electron workspace folders per suite

**Priority:** P2 recommended; also addresses P1 engineering stability TODO.

> Note: Acceptance reruns showed that workspace-folder cleanup alone is not enough because `@vscode/test-electron` reuses `.vscode-test/user-data` by default. Prior runs left temporary workspace/cache/history state in the reused VS Code profile, causing later Electron runs to validate deleted temp folders and make extension hosts unresponsive. The runner needs a fresh user-data/extensions profile per run, and Node-only package-layout checks should run outside Electron so synchronous `vsce package` work does not compete with the extension host. A fresh profile also starts in single-folder mode unless launched with a workspace file, so the Electron runner must open a temporary `.code-workspace` to exercise add/remove workspace-folder APIs reliably.

**Files:**
- Create: `unity-shader-nav/tests/integration/client/helpers/workspace.ts`
- Modify: `unity-shader-nav/tests/integration/client/*.test.ts`
- Modify: `unity-shader-nav/tests/client/suite/index.ts` if suite ordering/separate runs are needed
- Test: existing test-electron suite

**Why:** Electron tests share one Extension Host and mutable workspace folders. Existing flakes cluster around rebuild/lifecycle/macros settings tests, and many helpers add folders without guaranteed cleanup.

**Steps:**
1. Extract helpers for `addWorkspaceFolder(folderPath)`, `removeWorkspaceFolder(folderPath)`, and `withWorkspaceFolder(folderPath, fn)`.
2. Migrate stateful tests first: `lifecycle.test.ts`, `rebuild-on-branch.test.ts`, `macros.test.ts`, `find-references.test.ts`, `multiroot.test.ts`.
3. Ensure every temporary workspace folder is removed in `finally`.
4. Stop using `workspaceFolders?.[0]` in tests that create their own folder; use the folder returned by the helper.
5. Re-run `node tests/out/runTest.js` repeatedly on Windows.

**Tests:**
- `npx tsc -p tests/tsconfig.json`
- `node tests/out/runTest.js`
- `npm test`

**Commit message:** `test(electron): isolate workspace folders`

### Task 4.2: Declare resource-scoped settings and cover multi-root overrides

**Priority:** P2 recommended.

**Files:**
- Modify: `unity-shader-nav/client/package.json`
- Modify: `unity-shader-nav/client/src/client.ts`
- Test: `unity-shader-nav/tests/integration/client/multiroot.test.ts`
- Test: `unity-shader-nav/tests/integration/client/macros.test.ts`

**Why:** Server-side scoped settings exist, but the VS Code manifest does not declare resource scope, and Electron coverage is thin for per-folder overrides.

**Steps:**
1. Decide scope per setting:
   - resource-scoped: `projectRoot`, `includeDirectories`, `excludePatterns`, `declarationMacros`, `findReferences.includePackages`;
   - keep global only if there is a specific reason, and document it in the test name.
2. Add `"scope": "resource"` for scoped settings in `client/package.json`.
3. Ensure `client/src/client.ts` sends scoped settings by URI/folder when the server asks or on configuration changes. If current server already has a resolver, verify the client supplies enough scope information.
4. Add Electron test with two workspace folders and conflicting `declarationMacros` or `includePackages`; each folder must observe its own setting.

**Tests:**
- `npx tsc -p tests/tsconfig.json`
- `node tests/out/runTest.js`
- `npm test`

**Commit message:** `fix(config): declare resource scoped settings`

### Task 4.3: Remove stale compiled Electron test leftovers

**Priority:** P3 deferred but cheap and useful.

**Files:**
- Modify: `unity-shader-nav/package.json`
- Maybe modify: `unity-shader-nav/tests/tsconfig.json`

**Why:** Root `clean` removes package `out` directories but not `tests/out`. Deleted or renamed Electron tests can remain compiled and still run.

**Steps:**
1. Add `tests/out` to the root `clean` script.
2. Optionally add a `pretest:electron` script that removes `tests/out` before `tsc -p tests/tsconfig.json`.
3. Verify no expected fixture output is under `tests/out`.

**Tests:**
- `npm run clean`
- `npm test`

**Commit message:** `chore(test): clean compiled electron tests`

### Task 4.4: Add CI cache/pre-download strategy for `.vscode-test`

**Priority:** P3 deferred unless CI is being introduced now.

**Files:**
- Modify or create CI workflow file if present, for example `.github/workflows/*.yml`
- Modify: `docs/superpowers/PROGRESS.md` after implementation, not during this plan-only task
- Maybe create: `unity-shader-nav/scripts/download-vscode-test.mjs`

**Why:** `@vscode/test-electron` downloads a large VS Code build. CI will be slow and flaky without cache or pre-download.

**Steps:**
1. Locate the CI workflow. If none exists, create a follow-up CI plan instead of adding ad hoc workflow files.
2. Cache `.vscode-test/` using OS, VS Code version, and `@vscode/test-electron` version as key inputs.
3. Add a pre-download step only if cache miss behavior remains unreliable.

**Tests:**
- CI dry run or local command used by workflow.
- `npm test`

**Commit message:** `ci(test): cache vscode electron downloads`

---

## Phase 5: Lower-Priority Polish / Deferred P3

Acceptance for this phase depends on which deferred task is selected. Do not bundle these into the P1/P2 release branch unless the release owner explicitly expands scope.

### Task 5.1: Add runtime watch/dev script for F5 layout

**Priority:** P3 deferred.

**Files:**
- Modify: `unity-shader-nav/package.json`
- Modify: `unity-shader-nav/client/package.json`
- Modify: `unity-shader-nav/server/package.json`
- Maybe create: `unity-shader-nav/scripts/watch-runtime.mjs`

**Why:** Current `watch` scripts run `tsc -w` only and do not maintain `client/out/server` or esbuild output. F5 users may run stale runtime code.

**Steps:**
1. Decide whether `watch` remains typecheck-only or becomes runtime-producing.
2. If runtime-producing, add a script that watches client/server/shared and rebuilds/copies/bundles output with debounce.
3. If typecheck-only, rename or document it clearly, then add a `watch:runtime` script.

**Tests:**
- Start `npm run watch:runtime`, edit a server file, confirm `client/out/server/server.js` updates.
- `npm run build`

**Commit message:** `chore(dev): add runtime watch script`

### Task 5.2: Harden cross-process cache writes

**Priority:** P3 deferred; only needed for multiple VS Code windows on the same Unity project.

**Files:**
- Modify: `unity-shader-nav/server/src/cache/cacheStore.ts`
- Test: `unity-shader-nav/server/tests/cache/cacheStore.test.ts`

**Why:** Same-process cache saves are serialized, but two server processes can still interleave writes. Current `writeManifest()` also removes the old file before rename, creating a small missing-file window.

**Steps:**
1. Remove explicit `fs.rm(this.path)` before `fs.rename()` where platform semantics permit atomic replacement; if Windows replacement blocks, use a lockfile/writer epoch strategy.
2. Add tests for no missing-file gap if it can be simulated in-process.
3. Treat this as best-effort because reliable cross-process testing is hard in unit tests.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/cache/cacheStore.test.ts`

**Commit message:** `fix(cache): harden manifest replacement`

### Task 5.3: Large-project performance pass

**Priority:** P3 deferred.

**Files:**
- Modify: `unity-shader-nav/server/src/workspace/workspace.ts`
- Modify: `unity-shader-nav/server/src/workspace/walkFiles.ts`
- Modify: `unity-shader-nav/server/src/cache/cacheManager.ts`
- Test: `unity-shader-nav/server/tests/workspace/workspace.perf.test.ts`

**Why:** Cold/warm restore uses serial `fs.stat()`, persist rewrites the full manifest, and `fullScan()` has no bounded concurrency. This matters for URP/HDRP-scale projects but should be driven by measurements.

**Steps:**
1. Add a synthetic performance harness with hundreds/thousands of files and fixed thresholds loose enough for CI.
2. Add bounded concurrency for `fullScan()` and refresh queues.
3. Consider cache manifest sharding or compression only after measuring JSON size and write time.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/workspace/workspace.perf.test.ts`
- Manual URP/HDRP project timing if available.

**Commit message:** `perf(workspace): bound large project indexing work`

### Task 5.4: Expand package resolver forms

**Priority:** P3 deferred.

**Files:**
- Modify: `unity-shader-nav/server/src/packages/packageResolver.ts`
- Test: `unity-shader-nav/server/tests/packages/packageResolver.test.ts`

**Why:** Builtin packages, `git+ssh`, and git `?path=` package forms are common in Unity projects but outside the MVP resolver.

**Steps:**
1. Add fixtures for each PackageManager form.
2. Preserve current lockfile behavior for registry and local packages.
3. Resolve only forms with deterministic local disk paths; do not attempt network fetches.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/packages/packageResolver.test.ts`

**Commit message:** `feat(packages): support additional unity package forms`

### Task 5.5: Expand chain lookup L3b/L4

**Priority:** P3 deferred.

**Files:**
- Modify: `unity-shader-nav/server/src/index/chainLookup.ts`
- Test: `unity-shader-nav/server/tests/index/chainLookup.test.ts`
- Test: `unity-shader-nav/tests/integration/client/chain-lookup.test.ts`

**Why:** Current chain lookup handles explicit parameter/local/global receiver types. Arrays, nested fields, RHS call return inference, and cbuffer-contained structs remain out of scope.

**Steps:**
1. Add failing unit tests for exactly one new inference level at a time.
2. Implement RHS call return type inference before nested arrays/fields.
3. Add one Electron smoke after unit behavior is stable.

**Tests:**
- `npm run test -w @unity-shader-nav/server -- --run tests/index/chainLookup.test.ts tests/handlers/definition.test.ts`
- `npm test`

**Commit message:** `feat(definition): expand member chain lookup`

---

## Execution Notes

- First action in any implementation session: read `docs/superpowers/PROGRESS.md`, then this plan.
- This plan intentionally avoids Plan 01-13 grouping; execute by phase and task order above.
- One Task equals one commit. Do not combine unrelated tasks into one commit.
- Commit messages above are exact recommended messages; they use conventional commits and do not include task/step numbers.
- If the implementation reality differs from this plan, first edit this file and add a `> Note:` under the affected task explaining the deviation, then continue.
- Do not use `--no-verify`, `--force-with-lease`, or `git reset --hard`.
- Do not create a branch with a `codex/` prefix. For this plan-writing task, do not create any branch and do not commit.
