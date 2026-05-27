# Clean Electron Test Output Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure stale compiled Electron integration tests under `unity-shader-nav/tests/out` are removed before clean/test rebuilds, so local and CI test runs execute only current TypeScript sources.

**Architecture:** Keep the fix at the npm script layer because `tests/out` is generated TypeScript output, not source state. Extend `npm run clean` to delete `tests/out`, and route the Electron test compile step through a dedicated script that removes `tests/out` before `tsc -p tests/tsconfig.json` recreates it. Do not delete test source fixtures.

**Tech Stack:** npm scripts, TypeScript `tsc`, `rimraf`, Mocha, VS Code Electron tests via `@vscode/test-electron`.

---

**Plan-authoring commit guidance:** When writing or reviewing this plan document, commit only `docs/plans/2026-05-27-issue-5-clean-electron-test-output.md` with a docs commit such as `docs(issue-5): plan clean electron test output`. The implementation commit in Task 7 is for the future executor after changing `unity-shader-nav/package.json`.

### Task 1: Confirm Current Failure Mode

**Files:**
- Inspect: `unity-shader-nav/package.json`
- Inspect: `unity-shader-nav/tests/tsconfig.json`
- Inspect: `unity-shader-nav/tests/runTest.ts`

**Step 1: Create a stale compiled-output sentinel**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
New-Item -ItemType Directory -Force -Path tests\out | Out-Null
Set-Content -Path tests\out\stale-electron-output.js -Value "throw new Error('stale output survived clean');"
Test-Path tests\out\stale-electron-output.js
```

Expected: prints `True`.

**Step 2: Verify current clean does not remove the sentinel**

Run:

```powershell
npm run clean
Test-Path tests\out\stale-electron-output.js
```

Expected before the fix: `npm run clean` exits 0, then `Test-Path` prints `True`.

**Step 3: Do not commit the sentinel**

Run:

```powershell
git status --short
```

Expected: `unity-shader-nav/tests/out/stale-electron-output.js` may appear as untracked. Do not stage or commit it. If you stop before Task 3 removes it, clean it up manually:

```powershell
Remove-Item -LiteralPath tests\out\stale-electron-output.js -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath tests\out -Recurse -Force -ErrorAction SilentlyContinue
```

---

### Task 2: Update Root npm Scripts

**Files:**
- Modify: `unity-shader-nav/package.json`

**Step 1: Add a dedicated Electron test compile script**

Update the root `scripts` object so:

```json
{
  "test": "npm run build && npm run compile:tests && npm run test:package-layout && node tests/out/runTest.js && npm run test --workspaces --if-present",
  "compile:tests": "rimraf tests/out && tsc -p tests/tsconfig.json",
  "clean": "rimraf client/out server/out shared/out tests/out client/tsconfig.tsbuildinfo server/tsconfig.tsbuildinfo shared/tsconfig.tsbuildinfo"
}
```

Leave unrelated scripts unchanged.

**Step 2: Confirm no source fixture paths are included in deletion**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
Select-String -Path package.json -Pattern "rimraf"
```

Expected: the only new deleted test path is `tests/out`; there is no broad `tests` deletion and no fixture path deletion.

---

### Task 3: Verify Clean Removes Generated Test Output Only

**Files:**
- Verify: `unity-shader-nav/package.json`

**Step 1: Recreate generated-output sentinel and verify fixtures exist**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
New-Item -ItemType Directory -Force -Path tests\out | Out-Null
Set-Content -Path tests\out\stale-electron-output.js -Value "throw new Error('stale output survived clean');"
Test-Path tests\integration\client\fixtures\single-file\test.hlsl
Test-Path tests\integration\client\fixtures\refs-project\ProjectSettings\ProjectVersion.txt
```

Expected: the fixture checks print `True`.

**Step 2: Run clean**

Run:

```powershell
npm run clean
Test-Path tests\out
Test-Path tests\integration\client\fixtures\single-file\test.hlsl
Test-Path tests\integration\client\fixtures\refs-project\ProjectSettings\ProjectVersion.txt
```

Expected:
- `npm run clean` exits 0.
- `Test-Path tests\out` prints `False`.
- Each fixture check prints `True`.

---

### Task 4: Verify Test Compile Recreates Output

**Files:**
- Verify: `unity-shader-nav/package.json`
- Verify generated output under `unity-shader-nav/tests/out`

**Step 1: Compile tests from an empty output directory**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
npm run clean
npm run compile:tests
Test-Path tests\out\runTest.js
Test-Path tests\out\client\suite\index.js
Test-Path tests\out\client\package-layout.test.js
Test-Path tests\out\integration\client\definition.test.js
```

Expected:
- `npm run compile:tests` exits 0.
- All four `Test-Path` checks print `True`.

**Step 2: Verify stale output is removed before compile**

Run:

```powershell
Set-Content -Path tests\out\stale-electron-output.js -Value "throw new Error('stale output survived compile');"
npm run compile:tests
Test-Path tests\out\stale-electron-output.js
```

Expected:
- `npm run compile:tests` exits 0.
- `Test-Path tests\out\stale-electron-output.js` prints `False`.

---

### Task 5: Run Focused Verification

**Files:**
- Verify: `unity-shader-nav/tests/out/client/package-layout.test.js`

**Step 1: Run the package-layout smoke test**

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
npm run test:package-layout
```

Expected: Mocha exits 0.

---

### Task 6: Run Full Verification

**Files:**
- Verify: `unity-shader-nav/package.json`

Run from `F:\Project\UnityShaderNav\unity-shader-nav`:

```powershell
npm run clean
Test-Path tests\out
npm test
```

Expected:
- `Test-Path tests\out` prints `False` after clean.
- `npm test` exits 0 after rebuilding packages, recreating `tests/out`, running package-layout tests, running Electron tests, and running workspace tests.

---

### Task 7: Review Diff and Commit

**Files:**
- Commit: `unity-shader-nav/package.json`

**Step 1: Review changed files**

Run from `F:\Project\UnityShaderNav`:

```powershell
git diff -- unity-shader-nav/package.json
git status --short
```

Expected:
- Diff shows only root npm script changes in `unity-shader-nav/package.json`.
- No fixture files are modified or deleted.
- No generated `unity-shader-nav/tests/out` files or sentinel files appear in git status.

**Step 2: Commit**

Run:

```powershell
git add unity-shader-nav/package.json
git commit -m "fix(issue-5): clean electron test output"
```

Expected: commit succeeds with exactly `unity-shader-nav/package.json` included.
