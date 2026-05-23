# Plan 13 Self Review

Date: 2026-05-23

Scope reviewed: `7310c26` plus local fix work for `textDocument/references`, workspace reference indexing, package filtering, and integration fixtures.

## Finding

### P1: package declarations were not filtered when `includeDeclaration` was true

The initial references handler filtered `ReferenceEntry` locations through `Workspace.isInPackages()`, but declaration-as-reference locations from `workspace.global.lookup()` bypassed the same filter. If VSCode requested references with `context.includeDeclaration === true` on a symbol declared in `Packages/`, default user-file mode could still return the package declaration.

Fix: added a focused failing unit test in `server/tests/handlers/references.test.ts` and applied the package filter to declaration locations as well.

Verification:

- RED: `npm run test -w @unity-shader-nav/server -- --run tests/handlers/references.test.ts` failed with the package declaration still present.
- GREEN: same command passed 4/4 after filtering declaration locations.

## No Further Findings

- `Workspace.globalRefs` now follows cache restore, disk scan, live reindex, close-document restoration, drop, and rebuild clear paths.
- `Workspace.isInPackages()` uses normalized path containment through the existing workspace helper, which is appropriate for Windows paths.
- Handler registration mirrors the established async request lifecycle with `WorkspaceManager.workspaceForOrCreateFile()` and `RequestSuspender`.
