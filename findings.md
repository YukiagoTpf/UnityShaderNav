# Plan 13 Find References Findings

- Current branch at session start: `plan12-macro-definitions`.
- Existing dirty file: `AGENTS.md`, matching the user-provided project instruction update: no codex-prefixed branches, task commits, conventional commit wording, and removal of obsolete Windows sandbox warning.
- `docs/superpowers/PROGRESS.md` marks Plan 13 as P1 pending and says next step is Shift+F12 user files / Packages switch.
- Plan 13 tasks: add `GlobalReferenceIndex`, wire it into `Workspace`, register `textDocument/references`, add Electron integration for user references and Packages toggle, then update README.
- Existing settings surface already includes `unityShaderNav.findReferences.includePackages` in shared/client/server settings; no client package schema work appears necessary despite the plan note.
- `Workspace` currently updates `store` + `global` in `bootstrapFromCache`, `indexAndStore`, `reindex`, `closeDocument`, `drop`, and clears both in `rebuild`; `globalRefs` must follow every one of those paths.
- `definition.ts` already uses `workspaceForOrCreateFile()` and `RequestSuspender`; references handler should mirror that lifecycle rather than the older synchronous plan snippet.
- Existing `projectA` fixture already has a user-file call `Core()` in `Assets/Shaders/Main.shader` and a package declaration in `Packages/com.example.urp/ShaderLibrary/Core.hlsl`; it is useful for package filtering tests.
- `PackageResolver.allPaths()` returns physical roots that must be compared using normalized path containment, not string `path + '/'`, because this repo runs on Windows.
- `onSettingsChanged()` already delivers merged `ExtensionSettings`, but review showed references must read `workspace.settings.findReferences.includePackages` so multi-root workspaces use the scoped setting snapshot.
- Integration tests can add their fixture root as a workspace folder at runtime; Unity root detection only needs `Assets/` and `ProjectSettings/`, while embedded package scanning is driven by `Packages/packages-lock.json`.
