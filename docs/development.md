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
grammar wasm, and complete `web-tree-sitter` runtime. Build, watch, packaging,
package-layout tests, and Electron staging derive these paths from the same
runtime artifact graph; do not add parallel asset lists to their callers.

Use `npm run watch:typecheck` only when you want TypeScript watch mode without
refreshing the Extension Development Host runtime layout.

The output channel is named `UnityShaderNav`.

## Useful Commands

Run from the repository root:

```powershell
npm run check:fast
npm run check:knowledge
npm run check:artifacts
npm run build
npm run watch
npm run test -w @unity-shader-nav/server
npm run test:package
npm test
npm run test:electron:activation
npm run test:electron
npm run bench:index-cache -- --files 800
npm run bench:document-analysis -- --passes 32 --properties 64 --iterations 250 --warmup 50
npm run package:vsix
npm run grammar:rebuild
```

## Testing Strategy

- `npm run check:fast` is the authoritative local and CI feedback path. It
  first verifies workspace/lock identity, the public knowledge surface, and the
  runtime artifact graph, then
  removes generated output, rebuilds current TypeScript source, and runs the
  complete language-server test suite without starting or downloading VS Code.
- `npm run check:knowledge` is an offline integrity check for public local
  links and anchors, ADR identities and paths, repository-safe source
  references, Agent entrypoints, and the vendored grammar provenance, artifact,
  and upstream license.
- Parser and index behavior belongs in server unit tests.
- Shared built-in language facts belong in `vocabulary.ts` roles and narrow
  projections. Do not add caller-local ShaderLab keyword, Property-type,
  state-head, or state-value name sets. Vocabulary tests must cover the role,
  exact lookup, context, callable, lexical, and Property-type APIs; consumer
  tests must prove the resulting parser, Completion, Hover, and Signature Help
  behavior. Extension Host semantic-token tests decode exact token positions
  and types for cross-consumer vocabulary changes.
- Parser-runtime tests cover the source, tsc-out, copied-server, and bundled
  layouts with real grammar loading. They must prove that parser readiness,
  implementation identity, and cache fingerprints consume the same captured
  bytes; missing or unknown assets cannot use a fallback fingerprint.
- Include-resolution rule tests inject an in-memory `FileProbe`; they do not use
  disk fixtures to prove candidate ordering or casing behavior. Handler and
  Electron include tests exercise the default Node filesystem adapter and its
  production wiring.
- Document-analysis tests should prove exact-source matching, immutable shared
  blocks/structure/tokens, index-only versus full demand, and revision-owned
  live lifetimes. `FileIndex.structure` is a durable projection; disk/cache
  records must remain free of the analysis container, source, and lexical facts.
- `npm run test:package` is the authoritative package check. One invocation
  removes generated output, rebuilds current source, creates the versioned VSIX,
  verifies its content-addressed input/output manifest and every packaged
  server/grammar/runtime byte, then runs package-layout tests. The
  package-layout gate resolves the shipped grammar through the same runtime
  adapter as the bundled server, loads it, and verifies its bytes and identity.
- Thin LSP adapter behavior belongs in server handler tests. Every index-backed
  query adapter and the document lifecycle fake only Indexed Workspace behavior;
  tests must not reconstruct `store/global/globalRefs` Workspace shapes or
  assert through a concrete `WorkspaceIndex`.
- Query semantics belong in revision/Workspace tests that call the same
  Indexed Workspace methods and production query implementation used by the
  server. Live overlay, disk fallback, stale-attempt, rebuild replay,
  cross-document ordering, include visibility, and Package filtering tests use
  a real published revision or `Workspace`.
- Project suggestion policy belongs in candidate-selector interface tests.
  Cover prefix, inclusive scope and declaration order, nearest shadowing,
  current/include rank, transitive include exclusion, function versus display
  dedupe, root/array/nested member inference, mixed-arity signature focus, and
  missing-index versus empty-selection results. Revision tests must prove a
  forked publication cannot change the old selector. Extension Host coverage
  must exercise ordinary completion, receiver member completion, and a later
  argument whose first compatible overload is not candidate zero.
- Symbol-selection interface tests own Scope range, declaration order,
  Proximity tie-break, local shadowing, and include-visible global candidates.
  Published query tests must prove Definition, Hover, Completion, and member
  Completion select the same nearest parameter/local; architecture checks keep
  those rules out of resolver, chain, and suggestion consumers.
- Full candidate-construction tests target
  `IndexedRevisionCandidateConstructor` directly. Cover cold source scan, warm
  restore, invalid or changed cache fallback, missing cached files, compatible
  source retention, incompatible-retention abort, parser and Package
  infrastructure failure, and incomplete or cancelled discovery. Assert a
  complete unpublished builder; these tests must not publish a revision.
- Indexed-source-membership contract tests cover standalone files, Unity user
  files, configured exclusions, resolved embedded/external packages, unlisted
  Package paths, and `Documentation~` / `Samples~`. Discovery and direct URI
  admission must agree; lifecycle tests additionally prove watcher and close
  paths consume the captured revision fact.
- Publication tests must distinguish candidate state from published state.
  Cover copy-on-write isolation, the one-shot builder, one revision increment
  per successful pointer swap, and last-known-good query/persistence behavior
  during and after a failed rebuild. Initial, warm, rebuild, and recovery tests
  exercise complete transactions through `Workspace`. For deterministic gates,
  inject an `IndexedRevisionCandidateConstructor` that returns a real complete
  builder; do not mock a public/internal bootstrap phase, depend on a staged/take
  handoff, or synthesize an empty candidate. Do not inspect private stores to
  prove externally observable behavior.
- Cache-persistence tests use deferred barriers rather than timing assumptions.
  Cover one active plus latest pending request, replacement waiter inheritance,
  coordination across separate `CacheManager` instances for one path, failure
  followed by pending drain, and preservation of the previous manifest after a
  failed replacement. Session revisions must not be treated as a cross-process
  ordering token.
- Cache-identity tests cover a real cold/warm restart across equivalent Windows
  drive-letter Workspace URIs and use `node:path.win32` for filesystem path
  comparisons; changing only `process.platform` on a POSIX path implementation
  is not a valid Windows-path test. Package restore tests include a `source: local`
  package outside the Unity root and prove that removing it from the
  lockfile removes both cached symbols and references.
- Async lifecycle races use explicit deferred barriers and observable eventual
  conditions at the candidate-constructor or document-indexing boundary. Do not
  add fixed settle sleeps to make a parse/close/edit race appear deterministic.
- Workspace routing tests must cover nested-root ownership in both directions:
  add transfers the overlay away from the parent, remove republishes the latest
  open snapshot, and close leaves no stale former owner.
- An open-document request whose exact attempt is not published may join the
  registry's current `openId + version` through Workspace behavior; if no
  attempt can publish, it returns the feature's neutral result. Tests must
  establish index state through lifecycle/Workspace behavior rather than adding
  a handler-local reindex mock. Queries already backed by a retained revision
  must remain observable while a rebuild candidate is blocked or fails.
- VS Code activation belongs in `tests/client`; command-level feature tests and
  their fixtures belong in `tests/integration/client`.
- Integration synchronization must use the production index-status path or an
  explicit eventual feature condition. Use the shared `getIndexStatus`,
  `waitForIndexStatus`, and `waitForEventually` helpers instead of fixed settle
  sleeps. Eventual-condition timeouts use a hard deadline and report the last
  status, status error, query result, and query error so CI failures preserve
  the state needed for diagnosis.
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
- Package-layout verification directly spawns the index-cache benchmark with
  three generated files. This is a correctness smoke for real initialization,
  persistence, warm restore, and symbol visibility, not a timing threshold.
- Add fixtures that describe the shader shape being fixed. Small, explicit
  fixtures are easier to maintain than copied production shaders.

## Index Cache Benchmark

Build production output first, then run the synthetic 800-file benchmark:

```powershell
npm run build
npm run bench:index-cache -- --files 800
```

The benchmark performs cold and warm `Workspace.initialize` cycles, resolves
the manifest through the production `chooseCacheDir`, and records a separate
explicit persist. It fails unless the manifest is non-empty, warm initialization
reports cache restoration, and the restored index exposes a workspace symbol.
Its JSON output includes project and cache paths, file and cache-byte counts,
cold/warm/persist milliseconds, `warmRestored`, `symbolName`, and
`symbolAvailable`. Timing fields are diagnostic and have no CI threshold.

To measure a disposable copy of a real Unity project, point the command at that
copy:

```powershell
npm run bench:index-cache -- --project <path>
```

The benchmark writes the production cache beneath that copy's `Library/`. For a
real project, it selects one visible project symbol during the cold run and
requires the warm run to restore it. Add `--keep` only for a generated synthetic
project whose cache and files should remain available for inspection.

## Document Analysis Benchmark

Build the server output first, then run the benchmark from the repository root:

```powershell
npm run build
npm run bench:document-analysis
```

The command generates one representative multi-pass ShaderLab source and
alternates two paths in the same Node.js process. The legacy path independently
composes indexing block discovery, structure scanning, Properties scanning, and
lexical-token block discovery; the shared path runs one full `analyzeDocument`,
uses its structure, and passes its blocks to `scanProperties`. Output includes
block, structure-node, property, and token counts plus sample count, median,
p95, and the shared-to-legacy ratio. Count equality is a correctness check.
Timing is diagnostic only: there is deliberately no timing threshold in CI,
and performance comparisons should use the same machine, build, and arguments.

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

At runtime the grammar is not located through Workspace paths. The parser
runtime-assets Module maps the four supported build layouts to one exact file,
captures its bytes for the successful parser attempt, and supplies that same
fact to cache compatibility. Missing or unrecognized layouts fail observably.

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
