# Plan01 Code Review Report

Review date: 2026-05-22

Scope:
- Plan document: `docs/superpowers/plans/2026-05-22-01-project-scaffolding.md`
- Product commits: `657ec18..d76c4a8`
- Reviewed code under `unity-shader-nav/`, excluding later Plan02 parser additions except where they affect Plan01 test behavior.

## Findings

### P1 - Packaged extension cannot include the server with the current layout

References:
- `unity-shader-nav/client/package.json:13`
- `unity-shader-nav/client/src/client.ts:11`
- `unity-shader-nav/client/src/client.ts:12`
- `unity-shader-nav/scripts/build.mjs:12`
- `unity-shader-nav/scripts/build.mjs:13`

`client/package.json` is the VSCode extension manifest, so a normal `vsce package` flow would run from `unity-shader-nav/client`. The LSP client then resolves the server with:

```ts
context.asAbsolutePath(path.join('..', 'server', 'out', 'server.js'))
```

That path works only in the monorepo development layout. A packaged extension rooted at `client/` will not contain `../server/out/server.js`. Running `vsce` from the monorepo root is not a clean alternative either, because the root `package.json` is a workspace manifest, not the extension manifest. `scripts/build.mjs` also outputs the server to `server/out/server.js`, still outside the extension root.

Impact: F5 and test-electron can pass while VSIX install or marketplace publish produces an extension that cannot start its language server.

Recommended fix:
- Decide one extension package root.
- Either move the extension manifest to the monorepo root and package both `client/out` and `server/out`, or copy/bundle the server into the client package, for example `client/out/server.js`, and resolve it with `context.asAbsolutePath('out/server.js')`.
- Add a release smoke test that packages the VSIX and verifies activation from the packaged artifact.

### P2 - Activation integration test bypasses the activation event it claims to test

References:
- `unity-shader-nav/tests/client/activation.test.ts:5`
- `unity-shader-nav/tests/client/activation.test.ts:12`
- `unity-shader-nav/tests/client/activation.test.ts:16`
- `unity-shader-nav/client/package.json:14`
- `unity-shader-nav/client/package.json:15`

The test opens a ShaderLab document, then explicitly calls `ext.activate()`. That means the test would still pass if `activationEvents` were accidentally removed or changed to the wrong language id, because manual activation bypasses event-driven activation.

Impact: A core Plan01 acceptance point, "extension activates on Unity Shader file types", is not actually protected by the integration test.

Recommended fix:
- Locate the extension first.
- Open/show a `.shader` or `shaderlab` document.
- Wait/poll for `ext.isActive === true` without calling `ext.activate()`.
- Add at least one `.hlsl`/`.compute` activation case, because both language ids are part of the Plan01 surface.

### P2 - Missing `publisher` keeps the extension on a non-canonical id path

References:
- `unity-shader-nav/client/package.json:1`
- `unity-shader-nav/client/package.json:2`
- `unity-shader-nav/tests/client/activation.test.ts:12`
- `unity-shader-nav/tests/client/activation.test.ts:13`

The manifest has `name` but no `publisher`. The current test works around this by scanning all extensions and comparing `packageJSON.name`. That is acceptable for a development workaround, but it leaves the extension without the canonical `publisher.name` id used by VSCode APIs, extension dependencies, command routing expectations, and marketplace publishing.

Impact: Not blocking local Plan01 development, but it is a release gate and keeps tests away from the id shape users and VSCode will actually see.

Recommended fix:
- Add the intended `publisher`.
- Switch tests to `vscode.extensions.getExtension('<publisher>.unity-shader-nav')`.

### P2 - Server test script is already leaking across plan boundaries

References:
- `unity-shader-nav/server/package.json:9`
- `unity-shader-nav/package.json:13`

The server workspace test script runs `vitest run --root .. tests/server`. During this review, `npm test` executed the Plan01 handshake test and also picked up later Plan02 parser tests under `tests/server/parser/...`.

Impact: A failure in a future plan's uncommitted or in-progress tests can make the Plan01/server workspace test fail, even when the Plan01 server handshake product is unchanged. This makes bisecting and per-plan verification noisy.

Recommended fix:
- Move server-owned tests under `server/tests`, or
- Add a root-level vitest config with explicit projects/patterns, or
- Split scripts by scope, for example `test:handshake` and `test:server`.

### P3 - `clean` script is not portable on Windows npm defaults

Reference:
- `unity-shader-nav/package.json:14`

The script uses `rm -rf`. On Windows, npm scripts normally run through `cmd.exe`, where `rm` is not available by default. The repository is being worked on in a Windows environment, so this script is likely to fail outside PowerShell/Git Bash.

Impact: Low for current Plan01 validation because `clean` is not on the main build/test path, but it is a footgun for local development and CI.

Recommended fix:
- Replace with a cross-platform Node script, `rimraf`, or `shx rm -rf`.

## Verification

Commands run from `unity-shader-nav/`:

```bash
npm run build
npm test
node scripts/build.mjs
```

Results:
- `npm run build`: passed for `client`, `server`, and `shared`.
- `npm test`: passed. It ran 1 test-electron activation test and 12 vitest tests total, including later Plan02 tests under `tests/server/parser`.
- `node scripts/build.mjs`: passed and generated bundled `client/out/extension.js` and `server/out/server.js`.

## Summary

Plan01 is healthy for local development: TypeScript build, LSP startup path, and the current test harness pass. The main unresolved issue is packaging topology: the extension manifest lives in `client/`, while the server output lives outside that package root. Fix that before treating Plan01 as publish-ready. The activation test should also stop manually activating the extension so it can catch regressions in language activation events.
