# Plan 07 Code Review

Review subagent: `019e50d7-18ff-7c62-8772-40958c07e73e`

Range reviewed: `1737bad..5b22b34`

## Summary

Plan 07 is structurally aligned with the intended architecture: PackageResolver, Packages include branch, GlobalSymbolIndex, Workspace, WorkspaceManager, server wiring, cross-file tests, multi-root tests, and status mode notification are all present.

The review found blocking issues around Unity package-lock compatibility and lifecycle semantics once full-workspace indexing exists.

## Findings

### P1: Registry UPM packages are skipped unless `hash` exists

`server/src/packages/lockfile.ts` requires `entry.hash` for both `registry` and `git`, then maps to `Library/PackageCache/<name>@<hash>`.

The reviewer notes Unity registry package lock entries commonly contain `version`, `source: "registry"`, dependencies, and `url`, but no `hash`. This means normal `Packages/com.unity.../...` includes may not resolve or be indexed. Current tests encode the bad behavior by expecting registry-without-hash to return `null`.

### P1: Closing a workspace file deletes its full-scan index

`server/src/handlers/documents.ts` calls `workspace.drop(uri)` on every close.

After Plan 07, `Workspace.bootstrap()` indexes disk files into the workspace/global index. Closing an opened target such as `Common.hlsl` removes it from cross-file F12 until the next full scan. Close should discard live overlay state, not delete the persisted workspace scan entry.

### P2: `unityShaderNav.projectRoot` is ignored by the new workspace path

`server/src/workspace/workspace.ts` only uses `detectUnityRoot(folderPath)`.

If auto-detection fails but the user configured `projectRoot`, the workspace enters standalone mode with no `unityProjectRoot`, no PackageResolver, and no full scan. This regresses Plan 06 behavior where `buildContext()` preferred `settings.projectRoot || autoDetectedRoot`.

### P2: Newly added workspace folders use stale settings after configuration changes

`server.ts` registers the folder-change callback inside `onInitialized` and closes over the initial `settings`; later folder additions pass that old object to `manager.addFolder()`.

After a user changes declaration macros, include directories, excludes, or project root, folders added later bootstrap with old settings.

## Verification Notes

Reviewer ran:

```bash
npm test
```

Observed:

- test-electron: 13 passing
- server vitest: 29 files / 115 tests passing

## Verdict

Changes requested. Do not mark Plan 07 complete until these findings are fixed and covered by regression tests.
