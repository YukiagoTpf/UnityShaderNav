# Runtime Watch Script Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a development watch workflow that keeps the VS Code Extension Development Host runtime layout current while debugging with F5.

**Architecture:** Implement a root runtime watcher that reuses the existing deterministic build pipeline instead of creating a parallel build path. The watcher runs an initial runtime build, watches client/server/shared sources and runtime assets with one explicit watcher dependency, then debounces rebuilds so `client/out/extension.js`, `client/out/server`, grammar wasm, and vendored `web-tree-sitter` files stay current. Keep a typecheck-only watch alias for developers who only want `tsc -w`.

**Tech Stack:** Node.js 18 ESM scripts, `chokidar` 4 for cross-platform file watching, npm workspaces, TypeScript, esbuild, VS Code extension development host, Mocha package-layout tests.

---

## Context

Current behavior:

- Root `npm run build` runs workspace builds.
- `client/package.json` build runs `tsc -p .`, `node ../scripts/copy-server.mjs`, and `node ../scripts/build.mjs`.
- `copy-server.mjs` copies `server/out`, `server/grammars`, and `node_modules/web-tree-sitter` into the extension runtime layout.
- `build.mjs` bundles `client/src/extension.ts` and `server/src/server.ts`.
- `client/src/client.ts` launches the server from `out/server/server.js`.
- Existing root `npm run watch` delegates to workspace TypeScript watch scripts and does not refresh the runtime layout.

---

### Task 1: Add Package Layout Coverage

**Files:**
- Modify: `unity-shader-nav/tests/client/package-layout.test.ts`

**Step 1: Add script assertions**

Add focused assertions that the root scripts expose:

```text
scripts.watch === "node scripts/watch-runtime.mjs"
scripts["dev:watch"] === "node scripts/watch-runtime.mjs"
scripts["watch:typecheck"] === "npm run watch --workspaces --if-present"
```

**Step 2: Add one-shot runtime layout coverage**

Use `spawnSync(process.execPath, [path.resolve(root, "scripts/watch-runtime.mjs"), "--once"], { cwd: root, encoding: "utf8", timeout: 60000 })` from the package-layout test.

Assert status 0 and the existence of:

- `client/out/extension.js`
- `client/out/server/server.js`
- `client/out/grammars/tree-sitter-hlsl.wasm`
- `client/out/server/node_modules/web-tree-sitter/tree-sitter.js`
- `client/out/server/node_modules/web-tree-sitter/tree-sitter.wasm`

Use a timeout appropriate for a build-backed Mocha test.

**Step 3: Run package-layout tests to verify failure**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
npm run build
npm exec tsc -- -p tests/tsconfig.json
npm run test:package-layout
```

Expected:
- build exits 0.
- test TypeScript compile exits 0.
- package-layout suite fails because the root scripts and `scripts/watch-runtime.mjs` do not exist yet.

---

### Task 2: Add a Runtime Watch Script

**Files:**
- Create: `unity-shader-nav/scripts/watch-runtime.mjs`
- Modify: `unity-shader-nav/package.json`
- Modify: `unity-shader-nav/package-lock.json`

**Step 1: Add the watcher dependency**

Use `chokidar` as a direct root dev dependency. `node:fs.watch` would require extra recursive-directory handling for this Node 18 project, and issue #6 needs a practical runtime watch workflow rather than a custom watcher implementation.

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
npm install -D chokidar@^4.0.3
```

Expected: root `package.json` and `package-lock.json` record `chokidar` as a direct dev dependency. It may already appear transitively in the lockfile; the important change is the direct root dependency.

**Step 2: Create one-shot runtime build mode**

Create `unity-shader-nav/scripts/watch-runtime.mjs` as a Node ESM script. Implement this first:

- `node scripts/watch-runtime.mjs --once`
  - runs one runtime build by invoking the existing root `npm run build` script.
  - exits 0 when the build succeeds.
  - exits non-zero when the build fails.

Use `spawn` with `npm.cmd` on Windows and `npm` elsewhere when invoking npm scripts.

**Step 3: Add long-running watch mode**

Extend `scripts/watch-runtime.mjs` so this command works:

- `node scripts/watch-runtime.mjs`
  - runs an initial runtime build by invoking the existing root `npm run build` script.
  - watches these directories and files with `chokidar`:
    - `shared/src`
    - `server/src`
    - `client/src`
    - `server/grammars`
    - `node_modules/web-tree-sitter/tree-sitter.js`
    - `node_modules/web-tree-sitter/tree-sitter.wasm`
    - `tsconfig.base.json`
    - `shared/tsconfig.json`
    - `server/tsconfig.json`
    - `client/tsconfig.json`
    - `shared/package.json`
    - `server/package.json`
    - `client/package.json`
    - `scripts/copy-server.mjs`
    - `scripts/build.mjs`
  - debounces rebuilds by about 250 ms.
  - never runs overlapping builds; if changes arrive while a build is active, queue one rebuild afterward.
  - logs changed paths and build status with a `[watch-runtime]` prefix.

Keep generated output directories out of the watch list so rebuild output does not trigger another rebuild.

**Step 4: Update root scripts**

In `unity-shader-nav/package.json`, update only the relevant root scripts:

```json
{
  "watch": "node scripts/watch-runtime.mjs",
  "dev:watch": "node scripts/watch-runtime.mjs",
  "watch:typecheck": "npm run watch --workspaces --if-present"
}
```

Keep workspace `watch` scripts unchanged.

**Step 5: Verify one-shot runtime build**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
node scripts/watch-runtime.mjs --once
Test-Path client\out\extension.js
Test-Path client\out\server\server.js
Test-Path client\out\grammars\tree-sitter-hlsl.wasm
Test-Path client\out\server\node_modules\web-tree-sitter\tree-sitter.js
Test-Path client\out\server\node_modules\web-tree-sitter\tree-sitter.wasm
```

Expected:
- the script exits 0.
- all `Test-Path` checks print `True`.

**Step 6: Verify package-layout tests now pass**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
npm run build
npm exec tsc -- -p tests/tsconfig.json
npm run test:package-layout
```

Expected:
- build exits 0.
- test TypeScript compile exits 0.
- package-layout suite passes.

---

### Task 3: Document the F5 Development Loop

**Files:**
- Modify: `docs/development.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.ja.md`

**Step 1: Update development docs**

Update `docs/development.md` to say:

```markdown
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
```

**Step 2: Update README source-run instructions**

Update the source-run section in `README.md` with the shorter F5 loop:

```markdown
2. In a terminal, run `npm run watch` and wait for `[watch-runtime] build ok`.
3. Press F5 and choose the extension launch configuration.
4. In the Extension Development Host, open a Unity project.
5. After source edits, wait for `[watch-runtime] build ok`, then reload the Extension Development Host window.
```

The existing `README.zh-CN.md` and `README.ja.md` files repeat the same source-run instructions, so update those source-run steps too. Keep the localized edits focused on the F5 loop; do not expand unrelated documentation.

**Step 3: Verify documentation references**

Run from `F:\Project\UnityShaderNav`:

```powershell
rg -n "watch-runtime|watch:typecheck|Extension Development Host|F5" README.md README.zh-CN.md README.ja.md docs/development.md
```

Expected: updated docs describe the runtime watcher consistently, and `docs/development.md` also names `npm run watch:typecheck` as the typecheck-only watcher.

---

### Task 4: Verify Release Path and Manual Watch Behavior

**Files:**
- Verify changed implementation and docs.

**Step 1: Verify deterministic build/package checks**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
npm run clean
npm run build
node scripts/package-vsix.mjs --check-output
npm run test:package-layout
```

Expected:
- `npm run clean` removes generated output.
- `npm run build` recreates release/runtime outputs.
- `package-vsix.mjs --check-output` exits 0.
- package-layout tests pass.

**Step 2: Smoke-test the long-running watcher**

Start watcher in one terminal:

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
npm run watch
```

Expected: initial `[watch-runtime] build ok`, then watcher remains running.

In a second terminal:

```powershell
cd F:\Project\UnityShaderNav\unity-shader-nav
(Get-Item server\src\server.ts).LastWriteTime = Get-Date
```

Expected:
- watcher logs the changed path.
- one debounced rebuild runs.
- watcher logs `[watch-runtime] build ok`.

Stop the watcher with `Ctrl+C`.

Do not require a full `npm test` run for this issue unless the implementation changes broader server/client behavior beyond the runtime watch workflow.

---

### Task 5: Review Diff and Commit Implementation

**Files:**
- Commit likely:
  - `unity-shader-nav/scripts/watch-runtime.mjs`
  - `unity-shader-nav/package.json`
  - `unity-shader-nav/package-lock.json`
  - `unity-shader-nav/tests/client/package-layout.test.ts`
  - `docs/development.md`
  - `README.md`
  - `README.zh-CN.md`
  - `README.ja.md`

**Step 1: Review changed files**

Run from `F:\Project\UnityShaderNav`:

```powershell
git diff
git status --short
```

Expected:
- build outputs under `unity-shader-nav/client/out`, `server/out`, `shared/out`, or `tests/out` are not staged.
- runtime watcher code, tests, and docs are the only intentional changes.

**Step 2: Commit the implementation**

Run:

```powershell
git add unity-shader-nav/scripts/watch-runtime.mjs unity-shader-nav/package.json unity-shader-nav/tests/client/package-layout.test.ts docs/development.md README.md README.zh-CN.md README.ja.md
git add unity-shader-nav/package-lock.json
git commit -m "feat(issue-6): add runtime watch workflow"
```

---

## Plan Authoring Commit

When writing or revising this plan file before implementation, commit only:

```powershell
git add docs/plans/2026-05-27-issue-6-runtime-watch-script.md
git commit -m "docs(issue-6): plan runtime watch workflow"
```

The implementation commit in Task 5 is for the future execution of this plan, not for the plan-writing change itself.
