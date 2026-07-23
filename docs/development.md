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
  unity-adapter/   Editor-only Unity Package Manager Adapter
  tests/    VS Code integration tests and fixtures
  scripts/  build, packaging, benchmark, and helper scripts
  tools/    isolated Unity verification projects
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
npm run check:shader-budgets
npm run check:shader-contract
npm run check:gpu-capture-prototype
npm run check:visual-lab-prototype
npm run gpu-capture:preflight
npm run visual-lab:prototype -- --unity <Unity-executable>
npm run build
npm run watch
npm run test -w @unity-shader-nav/server
npm run test:package
npm test
npm run test:electron:activation
npm run test:electron
npm run bench:index-cache -- --files 800
npm run bench:index-fork -- --files 5000 --symbols 8 --iterations 100 --warmup 20
npm run bench:document-analysis -- --passes 32 --properties 64 --iterations 250 --warmup 50
npm run bench:live-document -- --functions 2000 --iterations 40 --warmup 10
npm run package:vsix
npm run grammar:rebuild
```

`npm run check:shader-budgets` is the same Shader Variant budget gate used by
CI. See [Shader Variant Budgets](shader-budgets.md) for the versioned contract,
baseline workflow, report path, and exit codes.

`npm run check:shader-contract` is the repository's aggregate compiler gate.
It verifies required profiles and capabilities, warning baselines, conservative
SRP Batcher Property contracts, and the Variant budget contract with one local
and CI command. See [Shader Compile Contract](shader-compile-contract.md).

`npm run check:gpu-capture-prototype` validates the bounded, sanitized
macOS/Metal/Xcode capture-correlation fixture. On a compatible Apple-silicon
host, set `UNITY_PATH` and use `npm run gpu-capture:preflight`, followed by the
explicit `npm run gpu-capture:capture` command to generate a real local trace
from the isolated Unity project. See
[GPU Capture-to-source Prototype](gpu-capture-prototype.md). Raw `.gputrace`
and Unity `Library/` output remain ignored derived data.

`npm run check:visual-lab-prototype` is the offline Visual Lab contract check
included by `npm run check:fast`. It verifies the real-runner wiring, isolated
UPM Adapter dependency, controlled Shader input, and exact independent R8
NaN/Inf mask contract without launching Unity.

Use the explicit real proof when a compatible Unity Editor is available:

```powershell
npm run visual-lab:prototype -- --unity <Unity-executable>
```

This command builds the current TypeScript runtime, launches the repository's
isolated Unity project in batch mode, discovers and authenticates its UPM
Adapter, and makes separate Before and After render requests. A passing run
requires two real 64x64 Unity frames, matching PNG hashes, and exactly 64 NaN
plus 64 infinite pixels in each 4,096-byte R8 mask. It does not open a product
Unity project and terminates only the process it launched. The command is an
explicit environment-dependent check; the offline command above, not an
unobserved Unity result, is what `check:fast` can prove. See
[Unity-rendered Visual Lab](visual-lab.md).

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
- Macro recognizer interface tests cover built-in and user declaration
  capture, invalid settings, structural sentinels, every supported pragma
  reference, lexical projection, and content identity. Consumers must not
  import raw built-in patterns or compiled pattern shapes; the architecture
  test enforces that boundary. Workspace tests cover live settings replacement,
  navigation, references, and semantic-token behavior without inspecting the
  recognizer's representation.
- Shared built-in language facts belong in `vocabulary.ts` roles and narrow
  projections. Do not add caller-local ShaderLab keyword, Property-type,
  state-head, or state-value name sets. Vocabulary tests must cover the role,
  exact lookup, context, callable, lexical, and Property-type APIs; consumer
  tests must prove the resulting parser, Completion, Hover, and Signature Help
  behavior. Extension Host semantic-token tests decode exact token positions
  and types for cross-consumer vocabulary changes.
- Parser-runtime tests cover the source, tsc-out, copied-server, and bundled
  layouts with real grammar loading. They must prove that parser readiness and
  cache fingerprints consume the same captured grammar hash, that the bundled
  layout reads the Extension release version, and that development layouts do
  not enable persistent cache. Missing or unknown assets cannot use a fallback
  fingerprint.
- Include-resolution rule tests inject an in-memory `FileProbe`; they do not use
  disk fixtures to prove candidate ordering or casing behavior. Handler and
  Electron include tests exercise the default Node filesystem adapter and its
  production wiring.
- Include-chain interface tests use the same `FileProbe` seam to cover
  multi-level traversal, cycles, missing intermediate indexes, Package mapping,
  case fallback, concurrent resolution/visibility/listing reuse, conservative
  failure caching, and caller isolation from the cached visibility Set.
  Published-revision tests prove multiple query capabilities consume the same
  captured chain and that a fork cannot change an older revision's visibility.
  Revision-scoped memoization belongs inside this boundary; do not add
  cross-revision/process caches or a parallel Package include helper.
- Document-analysis tests should prove exact-source matching, immutable shared
  blocks/structure/tokens, index-only versus full demand, and revision-owned
  live lifetimes. `FileIndex.structure` is a durable projection; disk/cache
  records must remain free of the analysis container, source, and lexical facts.
- Cache tests are behavior-oriented: cover complete `FileIndex` round-trip,
  typed malformed-value matrices for every persisted nested field, invalidation
  on release/settings/grammar changes, development-layout disable,
  fingerprint-first rejection of incompatible payloads, manager-level latest
  publication coordination, and atomic-rename crash safety. Do not restore
  historical-schema inventories or a second queue in `CacheStore`. The runtime
  decoder's mapped field validators are the active-schema drift gate; compatible
  records still require exact recursive validation before candidate restore.
- `npm run test:package` is the authoritative package check. One invocation
  removes generated output, rebuilds current source, creates the versioned VSIX,
  and then runs package-layout tests. Immediately before and after VSCE packaging,
  the shared runtime graph requires every bundle, grammar/runtime support file,
  language configuration, and staged metadata file to resolve to a repository-
  internal regular file and meet its declared minimum size. Every path returned
  by VSCE's public file plan must be a unique canonical relative path resolving
  to a regular file inside the Extension root, and the plan must include every
  required package path. Direct VSCE prepublish applies the same checks, and the
  resulting VSIX must itself be a non-trivial file. The
  package-layout gate also proves that a failed attempt restores staged metadata
  and removes only that attempt's exact versioned VSIX. It resolves the shipped
  grammar through the same runtime adapter as the bundled server, loads it, and
  verifies bundled release-cache eligibility while development layouts remain
  non-persistable.
- Thin LSP adapter behavior belongs in server handler tests. Every index-backed
  query adapter and the document lifecycle fake only Indexed Workspace behavior;
  tests must not reconstruct `store/global/globalRefs` Workspace shapes or
  assert through a concrete `WorkspaceIndex`.
- Portability tests keep version pairs in
  `server/tests/portability/fixtures/version-pairs.json` and the narrow unlit
  before/after sources under
  `server/tests/portability/fixtures/birp-urp-unlit/`. The protocol fixture
  proves deterministic edits plus separate exact-source hashes through a mock
  Adapter boundary; it is not a substitute for compiling both revisions with a
  real Unity Editor and must never be presented as captured compiler evidence.
- Visual Lab protocol tests cover explicit pin ownership, independent slot
  generations, every render-identity stale transition, late-response rejection,
  bounded canonical PNGs, and exact binary R8 bytes/counts without using image
  diffs. Client tests validate the same evidence before building a `data:` PNG
  or drawing the mask. IPC tests cover descriptor, framing, authentication,
  capability negotiation, reconnect, one-project sharing, and cross-project
  isolation. The offline prototype check proves the real-runner contract; only
  `npm run visual-lab:prototype -- --unity <Unity-executable>` proves a current
  environment performed the two Unity draws.
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
- Lifecycle tests call the Workspace-folder coordinator, scoped settings
  reconfiguration, and registered file watcher used by the server. Architecture
  checks reject test-only folder/global-settings entry points and any
  RequestSuspender parameter on watcher or rebuild paths. RequestSuspender unit
  and handler tests cover only the bounded cold-start gate; status registration
  stays outside it.
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
  Workspace URIs, plus case and NFC/NFD variants for default macOS volumes.
  Cross-platform unit tests inject both platform and the matching `node:path`
  implementation; changing only `process.platform` on a POSIX path implementation
  is not a valid Windows-path test. Linux cases preserve case and Unicode
  normalization distinctions. Package restore tests include a `source: local`
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
  POSIX (the OS temp directory on Windows). The sandbox contains only the
  graph-owned Extension staging set under `e/`; compiled tests, the three
  repository fixture trees, and a test-only `node_modules` link under `t/`; the
  copied selected workspace under `w/`; and isolated user data, Extension, and
  temp directories under `u/`, `x/`, and `m/`. `ws.code-workspace` points only
  at `w/`. Copying rejects existing `Library/` state, nested test temp
  directories stay inside `m/` through `TMPDIR`/`TMP`/`TEMP`, and both success
  and failure remove the complete sandbox.
- Tests that bootstrap a Unity project must copy repository fixtures to a
  disposable directory before allowing `Library/UnityShaderNavCache/` writes.
- Package-layout verification directly spawns the index-cache benchmark with
  three generated files. This is a correctness smoke for real initialization,
  persistence, warm restore, and symbol visibility, not a timing threshold.
- Add fixtures that describe the shader shape being fixed. Small, explicit
  fixtures are easier to maintain than copied production shaders.

## Runtime Package Contract

`npm run build` uses esbuild to minify the Extension and server entry points,
emits build-only source maps, assembles the graph-owned parser/runtime support
files, and generates `client/out/THIRD_PARTY_NOTICES.txt` from both bundle
metafiles. Notice generation is fail-closed: every bundled package must have
non-empty string `name`, `version`, and `license` manifest fields and at least
one license file. A failure removes a stale notices file instead of leaving it
available for packaging.

`npm run package:vsix` packages the exact 18-file graph allowlist described in
[Architecture](architecture.md). The public VSCE plan must match that allowlist,
so loose transpiled client/server modules, source maps, and a runtime artifact
manifest cannot enter the VSIX. After VSCE writes the archive,
`extension/out/terminateProcess.sh` is normalized to Unix mode `100755` on
Windows, macOS, and Linux; every other regular entry is normalized to `100644`.
The source file is copied from the public `vscode-languageclient` runtime to
`client/out/terminateProcess.sh` during assembly.

The Electron harness stages the same graph-owned Extension set used by package
verification, excluding only release documentation that is not needed for
activation (`README.md`, `CHANGELOG.md`, and `LICENSE`). Tests therefore run
against the two bundles and exact runtime support files rather than loose
workspace output. The test runner's repository `node_modules` link exists only
under the separate `t/` mirror and is never placed in the staged Extension.

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
Because it executes tsc-out development code, it opts into persistence with a
process-local synthetic release identity shared only by its cold and warm runs;
normal source, tsc-out, and copied-server sessions remain non-persistable.
Its JSON output includes project and cache paths, file and cache-byte counts,
cold/warm/persist milliseconds, `warmRestored`, `symbolName`, and
`symbolAvailable`. Timing fields are diagnostic and have no CI threshold.

To measure a disposable copy of a real Unity project, point the command at that
copy:

```powershell
npm run bench:index-cache -- --project <path>
```

The benchmark writes the standard cache manifest beneath that copy's `Library/`.
Its process-local identity rejects cache from an earlier benchmark invocation.
For a real project, it selects one visible project symbol during the cold run
and requires the warm run to restore it. Add `--keep` only for a generated
synthetic project whose cache and files should remain available for inspection.

## Index Fork Benchmark

Build the server output, then measure a published index with a large synthetic
file set:

```powershell
npm run build
npm run bench:index-fork -- --files 5000 --symbols 8 --iterations 100 --warmup 20
```

Each sample forks the same captured index and replaces one file's symbol and
reference shard. The benchmark verifies that the candidate sees the replacement
while the captured base still sees its original shard, then reports median and
p95 latency. Use identical arguments and the same machine for before/after
comparisons; timing is diagnostic and has no CI threshold.

## Document Analysis Benchmark

Build the server output first, then run the benchmark from the repository root:

```powershell
npm run build
npm run bench:document-analysis
```

The command generates one representative multi-pass ShaderLab source and
alternates two feature-equivalent paths in the same Node.js process. The
independent path runs the layout, Shader/Pass name, material-contract,
Properties/color, and lexical-token projections through their compatibility
Adapters, interpreting the source five times. The production path runs one
full `analyzeDocument`, interpreting the source once and projecting every fact
from that shared result. Output reports both source-walk counts; all projection
counts; sample count; median; p95; and the shared-to-independent ratio. Count
equality and the 5-to-1 source-walk reduction are correctness checks. Timing is
diagnostic only: there is deliberately no timing threshold in CI, and
performance comparisons should use the same machine, build, and arguments.

## Live Document Parsing Benchmark

Run the source benchmark from the repository root; a production build is not
required:

```powershell
npm run bench:live-document -- --functions 2000 --iterations 40 --warmup 10
```

The benchmark generates two large HLSL document versions that differ by one
local edit and include a non-BMP UTF-16 fixture. Before timing, it requires the
incremental and full paths to produce deeply equal `FileIndex` values. The
parse-only comparison measures tree-sitter with and without an edited old tree.
The end-to-end comparison measures the same `Workspace.updateDocument`
publication path against a baseline indexer that deliberately omits the live
session and performs a full parse. Runs alternate the two end-to-end paths and
report mean, median, p95, and median/p95 speedup as JSON. Timing is diagnostic,
has no CI threshold, and should be compared only on the same machine and build.

## Vendored HLSL Grammar

The checked-in grammar's source revision, public toolchain, container digest,
artifact checksum, and upstream license checksum have one machine-readable
source of truth in
[`tree-sitter-hlsl.provenance.json`](../server/grammars/tree-sitter-hlsl.provenance.json).

`npm run check:knowledge` verifies the checked-in artifact and license offline.
`npm run grammar:rebuild` performs a clean build from the pinned public source
and compares it byte for byte with the repository. It first verifies the
4,223,843-byte tree-sitter output, then runs the pinned `wasm-opt -Oz` from the
same pinned Emscripten image with networking disabled and verifies the
4,223,826-byte optimized output. This 17-byte reduction is a reproducible size
fact only; it does not establish a runtime performance improvement. The rebuild
requires Git, Docker, network access to GitHub, Docker Hub, and the public npm
registry for source and toolchain acquisition, and a runtime capable of
executing the pinned Linux/amd64 Emscripten image. The command is intentionally
verification-only: changing the vendored artifact is a separate, reviewable
provenance update.

At runtime the grammar is not located through Workspace paths. The parser
runtime-assets Module maps the four supported build layouts to one exact file,
captures its bytes for the successful parser attempt, and supplies that same
fact to cache compatibility. Missing or unrecognized layouts fail observably.

## CI

On every push and pull request to `main`, GitHub Actions first validates its CI
contract, then runs `npm run check:fast` in a non-cancelling matrix on Linux,
Windows, and macOS (`.github/workflows/ci.yml`). This gives every platform the
same clean build and complete language-server unit suite, including its native
path-identity cases. The Linux leg then runs `npm run test:package` as a
separately attributable current-run package check, installs the Electron runtime
libraries, and runs the prepared activation + integration profiles under
`xvfb`. The public `npm run test:electron` command includes the package gate
itself; CI calls the internal prepared command only because the preceding named
step already ran that same gate.

`.vscode-test/` is the explicit persistent download cache; it is not disposable
profile state. The Linux integration leg caches it with an identity made from
runner OS, runner architecture, the exact value in
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
