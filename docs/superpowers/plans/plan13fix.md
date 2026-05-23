# Plan 13 Review Fix

Date: 2026-05-23

Fix agent: Curie (`019e54a6-2054-70d0-a3d6-526e16d1f9a5`)

Source review: `docs/superpowers/plans/plan13review.md`

## Fixed

### P2: `includePackages` must be workspace-scoped

`registerReferencesHandler()` now resolves the workspace first and reads `workspace.settings.findReferences.includePackages`. The handler no longer receives a server-global settings callback from `server.ts`.

Regression: `server/tests/handlers/references.test.ts` covers a workspace whose local settings include package references.

### P3: `includePackages` toggle should not rebuild indexes

`applyScopedSettingsAndRebuild()` now compares index-affecting settings separately from `findReferences.includePackages`. If only the reference filter changes, it updates each workspace's settings/table and returns without suspension, rebuild, or open-document reindexing.

Regression: `server/tests/lifecycle/rebuild.test.ts` asserts that an includePackages-only change updates settings without calling `workspace.rebuild()` or open-document reindex.

### P3: integration settings cleanup

`tests/integration/client/find-references.test.ts` now resets `findReferences.includePackages` in a `finally` block. The setting remains workspace-scoped because the VSCode contribution does not declare folder resource scope for this property.

## Verification

- RED observed by fix agent: references handler test failed before workspace-scoped settings fix; rebuild test failed before includePackages-only optimization.
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/references.test.ts tests/lifecycle/rebuild.test.ts`: 2 files / 9 tests passed.
- Fix agent also reported `npm run build`, `npx tsc -p tests/tsconfig.json`, and full server vitest passing before handoff.
- Electron run still hit known unrelated rebuild/lifecycle timing flakes, while Find References integration tests passed.
