# Development Guide

UnityShaderNav is a TypeScript monorepo under `unity-shader-nav/`.

## Layout

```text
unity-shader-nav/
  client/   VS Code extension client
  server/   language server, parser, index, and LSP handlers
  shared/   shared protocol and data types
  tests/    VS Code integration tests and fixtures
  scripts/  build, packaging, benchmark, and helper scripts
```

## Setup

```powershell
cd unity-shader-nav
npm install
npm run build
```

## Run in VS Code

1. Open `unity-shader-nav/` in VS Code.
2. In a terminal, run `npm run watch`.
3. Wait for the initial `[watch-runtime] build ok` message.
4. Press F5.
5. In the Extension Development Host, open a Unity project.
6. After source edits, wait for the next `[watch-runtime] build ok` message, then run `Developer: Reload Window` in the Extension Development Host.

`npm run watch` maintains the Extension Development Host runtime layout under
`client/out/`, including the bundled client entry, copied server output,
grammar wasm, and `web-tree-sitter` runtime files.

Use `npm run watch:typecheck` only when you want TypeScript watch mode without
refreshing the Extension Development Host runtime layout.

The output channel is named `UnityShaderNav`.

## Useful Commands

Run from `unity-shader-nav/`:

```powershell
npm run build
npm run watch
npm run test -w @unity-shader-nav/server
npm test
npm run test:electron
npm run bench:issue3 -- --files 800
npm run package:vsix
```

## Testing Strategy

- Parser and index behavior belongs in server unit tests.
- LSP handler behavior belongs in server handler tests.
- VS Code activation, packaging layout, and command-level smoke tests belong in
  `tests/integration/client`.
- Add fixtures that describe the shader shape being fixed. Small, explicit
  fixtures are easier to maintain than copied production shaders.

## CI

GitHub Actions runs the same `npm test` chain on every push and pull
request to `main` (`.github/workflows/ci.yml`). The Electron integration
tests run on `ubuntu-latest` under `xvfb` with the Electron runtime apt
packages preinstalled.

`unity-shader-nav/.vscode-test/` is cached via `actions/cache@v4`. The
cache key is `vscode-test-<runner-os>-<hash of unity-shader-nav/package-lock.json>`,
so the cache automatically invalidates whenever the lockfile changes
(including transitive bumps to `@vscode/test-electron`, which is what
controls the downloaded VS Code build).

To force a refresh without changing dependencies, bump the cache key
suffix in the workflow. Locally `.vscode-test/` is managed by
`@vscode/test-electron` and does not require manual maintenance.

## Issue Fix Workflow

For a bug fix:

1. Capture the shader shape and expected behavior in a GitHub issue.
2. Add a failing focused test.
3. Implement the narrowest fix.
4. Run focused tests, then broader verification.
5. Update docs if the behavior or limits changed.
6. Comment the diagnosis, fix summary, verification, and commits back on the
   issue before closing.
