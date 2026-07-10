# Development Guide

UnityShaderNav is a TypeScript monorepo rooted directly at the Git repository
root. This single-root contract is recorded in
[ADR-0007](adr/0007-canonical-repository-root.md).

## Layout

```text
<repository>/
  package.json
  package-lock.json
  client/   VS Code extension client
  server/   language server, parser, index, and LSP handlers
  shared/   shared protocol and data types
  tests/    VS Code integration tests and fixtures
  scripts/  build, packaging, benchmark, and helper scripts
```

## Setup

```powershell
npm ci
npm run build
```

## Run in VS Code

1. Open the repository root in VS Code.
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

Run from the repository root:

```powershell
npm run check:fast
npm run check:knowledge
npm run build
npm run watch
npm run test -w @unity-shader-nav/server
npm run test:package
npm test
npm run test:electron:activation
npm run test:electron
npm run bench:index-cache -- --files 800
npm run package:vsix
npm run grammar:rebuild
```

## Testing Strategy

- `npm run check:fast` is the authoritative local and CI feedback path. It
  first verifies workspace/lock identity and the public knowledge surface, then
  removes generated output, rebuilds current TypeScript source, and runs the
  complete language-server test suite without starting or downloading VS Code.
- `npm run check:knowledge` is an offline integrity check for public local
  links and anchors, ADR identities and paths, repository-safe source
  references, Agent entrypoints, and the vendored grammar provenance, artifact,
  and upstream license.
- Parser and index behavior belongs in server unit tests.
- `npm run test:package` is the authoritative package check. One invocation
  removes generated output, rebuilds current source, creates the versioned VSIX,
  verifies its manifest and runtime files, then runs package-layout tests.
- LSP handler behavior belongs in server handler tests.
- VS Code activation belongs in `tests/client`; command-level feature tests and
  their fixtures belong in `tests/integration/client`.
- Electron tests use the exact VS Code release in `tests/vscode-version.txt`.
  `npm run test:electron:activation` proves language-triggered activation from
  an initially inactive extension; `npm run test:electron` runs activation and
  integration in separate profiles.
- Every Electron process stages its extension runtime, compiled tests, selected
  workspace, and repository fixtures under a short `/tmp/usn-*` sandbox on
  POSIX (the OS temp directory on Windows). Copying rejects existing `Library/`
  state, nested test temp directories stay inside the sandbox through
  `TMPDIR`/`TMP`/`TEMP`, and both success and failure remove the complete
  sandbox.
- Tests that bootstrap a Unity project must copy repository fixtures to a
  disposable directory before allowing `Library/UnityShaderNavCache/` writes.
- Add fixtures that describe the shader shape being fixed. Small, explicit
  fixtures are easier to maintain than copied production shaders.

## Vendored HLSL Grammar

The checked-in grammar's source revision, public toolchain, container digest,
artifact checksum, and upstream license checksum have one machine-readable
source of truth in
[`tree-sitter-hlsl.provenance.json`](../server/grammars/tree-sitter-hlsl.provenance.json).

`npm run check:knowledge` verifies the checked-in artifact and license offline.
`npm run grammar:rebuild` performs a clean build from the pinned public source
and compares it byte for byte with the repository. The rebuild requires Git,
Docker, network access to GitHub, Docker Hub, and the public npm registry, and a
runtime capable of executing the pinned Linux/amd64 Emscripten image. The
command is intentionally verification-only: changing the vendored artifact is
a separate, reviewable provenance update.

## CI

GitHub Actions runs `npm run check:fast` first on every push and pull request
to `main` (`.github/workflows/ci.yml`), then runs `npm run test:package` as a
separately attributable current-run package check. Only after both deterministic
checks pass does CI install the Electron runtime libraries and run
the prepared activation + integration profiles under `xvfb`. The public
`npm run test:electron` command includes the package gate itself; CI calls the
internal prepared command only because the preceding named step already ran
that same gate.

`.vscode-test/` is the explicit persistent download cache; it
is not disposable profile state. GitHub Actions caches it with an identity made
from runner OS, runner architecture, the exact value in
`tests/vscode-version.txt`, and the package-lock hash. There is no broad fallback
key that can silently select a different VS Code release. The lockfile component
also invalidates the cache when `@vscode/test-electron` changes.

To test a newer VS Code release, change the one version file and run the
activation and full Electron commands locally before committing it. Locally
`.vscode-test/` is managed by `@vscode/test-electron`; old explicitly pinned
runtimes may be deleted when no branch needs them.

## Issue Fix Workflow

For a bug fix:

1. Capture the shader shape and expected behavior in a GitHub issue.
2. Add a failing focused test.
3. Implement the narrowest fix.
4. Run focused tests, then broader verification.
5. Update docs if the behavior or limits changed.
6. Comment the diagnosis, fix summary, verification, and commits back on the
   issue before closing.
