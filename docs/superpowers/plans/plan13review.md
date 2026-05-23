# Plan 13 Code Review

Date: 2026-05-23

Reviewer: Franklin (`019e54a0-9b5b-7793-8989-f932138ac092`)

Range: `8a3fba8711ca7870006a82a1d4dfa9598e2d54cf..cf608473a7316018e2d5a895d9be398e3f90bec5`

## Summary

No P1/blocking findings. Focused server tests passed in the reviewer workspace across references, global references, and workspace coverage.

## Findings

### P2: `includePackages` uses a server-global settings snapshot

`server.ts` registers the references handler with a callback reading `settingsRef.findReferences.includePackages`. Existing workspace creation already supports scoped settings, so multi-root or folder-specific configurations can use the wrong package visibility setting for a queried file.

Recommended fix: resolve package inclusion from the matched workspace after `workspaceForOrCreateFile()`, for example `workspace.settings.findReferences.includePackages`, and add a regression for different workspaces/settings.

### P3: toggling `includePackages` rebuilds indexes even though it is only a result filter

Every settings change goes through `applyScopedSettingsAndRebuild`. For `findReferences.includePackages`, rebuilding is unnecessary because indexed data does not change.

Recommended fix: detect includePackages-only changes and update workspace settings without reindexing.

### P3: integration setting cleanup is fragile

`find-references.test.ts` enables `includePackages` and resets it at the end of the happy path. A failed assertion can leak workspace settings into later tests. The test also uses unscoped workspace configuration, so it does not exercise scoped settings.

Recommended fix: wrap reset in `finally`. Use scoped configuration if the manifest allows the setting to be folder-scoped; otherwise keep workspace scope and ensure cleanup.

## Residual Test Gaps

- No direct regression for cache restore populating `globalRefs`.
- No direct close-document disk-reference restoration assertion.
- No Electron test for `includeDeclaration` while filtering package declarations.
