# Plan 07 Review Fix

Date: 2026-05-23

Source review: `docs/superpowers/plans/plan07review.md`

Commit message:

```bash
fix(plan-07): address package resolver review findings
```

## Findings Fixed

1. P1 registry UPM packages without `hash` were skipped.
   - Added regression coverage for registry entries with `source: "registry"` and no `hash`.
   - `resolvePackagePhysicalPath()` now maps registry packages with `hash` to `Library/PackageCache/<name>@<hash>` and registry packages without `hash` to `Library/PackageCache/<name>@<version>`.
   - Git package handling remains strict: no `hash`, `git+ssh://`, and `?path=` still return `null`.
   - Added a `> Note:` near Task 1 / `resolvePackagePhysicalPath` in `2026-05-22-07-package-resolver-and-cross-file.md` to record this deviation from the original plan.

2. P1 closing a workspace file deleted its full-scan index.
   - Added regression coverage that opens/reindexes `Common.hlsl` with live-only content, then closes it and verifies the full-scan `Common` symbol is restored.
   - `Workspace` now retains disk indexes from full scan separately from live document overlays.
   - `registerDocuments()` now calls `Workspace.closeDocument()` on close, restoring the disk index when present and only deleting when no disk index exists.

3. P2 `settings.projectRoot` was ignored by `Workspace.bootstrap()`.
   - Added regression coverage where the workspace folder is not a Unity root but `settings.projectRoot` points to `projectA`.
   - `Workspace.bootstrap()` now uses non-empty `settings.projectRoot` before falling back to `detectUnityRoot()`.

4. P2 newly added workspace folders used stale settings after config changes.
   - Added regression coverage for `WorkspaceManager.configure()` followed by `addFolder()` with an older settings argument.
   - `WorkspaceManager.addFolder()` now prefers the manager's current configured settings and connection when available, so folders added after configuration changes bootstrap with the latest settings.

## Verification

Red run before implementation:

```bash
npm run test -w @unity-shader-nav/server -- --run tests/packages/lockfile.test.ts tests/workspace/workspace.test.ts tests/workspace/workspaceManager.test.ts tests/handlers/documents.test.ts
```

Observed expected failures for registry fallback, `Workspace.closeDocument()`, `settings.projectRoot`, stale manager settings, and document close routing.

Green targeted run:

```bash
npm run test -w @unity-shader-nav/server -- --run tests/packages/lockfile.test.ts tests/workspace/workspace.test.ts tests/workspace/workspaceManager.test.ts tests/handlers/documents.test.ts
```

Observed: 4 test files passed, 21 tests passed.

Final verification:

```bash
npm run build
npm test
```

Observed:

- `npm run build`: shared, server, and client build passed; server copy and bundle completed.
- `npm test`: test-electron 13 passing; server vitest 29 files / 118 tests passing.
