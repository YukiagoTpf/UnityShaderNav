# Phase 01-05 Full Review

Review date: 2026-05-23

Scope:
- Phase/Plan 01 through 05 implementation, fixes, and review documents.
- Main code under `unity-shader-nav/client`, `unity-shader-nav/server`, `unity-shader-nav/shared`, build scripts, and integration/unit tests.
- Existing docs: `plan01review/fix`, `plan02review/fix`, `plan03review/fix`, `plan04review/fix`, `plan05review/fix`, and `docs/superpowers/PROGRESS.md`.

Subagent:
- Independent read-only reviewer: `019e5095-7221-7c31-bd6a-766a28868f3a`.
- Verdict: the three original `plan03review.md` findings are no longer current after `plan03fix.md`; new risks remain around packaged runtime closure, global variable collection, pragma comment noise, and Plan 03 progress docs.

## Findings

### P1 - Packaged VSIX server entry had an incomplete runtime dependency closure

Status: confirmed, fixed in this review.

The copied server output under `client/out/server` was still plain `tsc` output that externally required `@unity-shader-nav/shared`, `vscode-languageserver/node`, `vscode-languageserver-textdocument`, and `web-tree-sitter`. The WASM path had been fixed by `plan03fix.md`, but a real VSIX install cannot rely on the monorepo root `node_modules` or a private workspace package.

Fix decision:
- Keep `copy-server.mjs` so parser submodule tests can import copied server files.
- Run `scripts/build.mjs` after copy-server in the client build so `client/out/server/server.js` is an esbuild bundle.
- Add `web-tree-sitter` to client runtime dependencies because `parser.ts` intentionally loads it dynamically through `createRequire`.
- Add package-layout assertions that the bundled server entry has no external `shared` / LSP requires and that `web-tree-sitter` is declared.

### P1 - Custom HLSL type usages were not emitted as `context='type'` references

Status: confirmed, fixed in this review.

The collector marked declaration `typeNode`s as declaration sites. That correctly avoided counting the definition of `struct S`, but it also suppressed real usages such as return type `S`, parameter type `S`, and local declaration type `S`.

Regression:
- `struct S { float x; }; S Make(S a) { S b; return a; }` now records three `S` type references and does not count the struct declaration itself.

### P2 - Top-level ordinary HLSL variable declarations were missing from `FileIndex.symbols`

Status: confirmed, fixed in this review.

The collector handled functions, structs, cbuffer-shaped parser fallback, locals, and macro declarations, but not ordinary top-level declarations such as `float4 _Color;` or `Surface gSurface;`. This would break later global/chain lookup work and is also related to the Plan 05 deferred CG legacy declaration gap.

Regression:
- `float4 _Color; struct Surface { float3 positionWS; }; Surface gSurface;` now emits `_Color` and `gSurface` as `kind='variable'`.

### P3 - `#pragma` scanning is not block-comment aware

Status: confirmed, deferred.

`matchPragmaLine` strips `//` only. A `#pragma vertex vert` inside a multi-line `/* ... */` block can be collected as a pragma reference. This is noise rather than a current F12 blocker because Plan 05 only consumes pragma references for same-file definition; it should be addressed before Plan 13 Find References alongside the existing sentinel-noise risk.

### P3 - Plan 03 documentation/progress state was stale

Status: confirmed, fixed in this review.

`plan03fix.md` was tracked and the code had the `b4519cf` fixes, but `docs/superpowers/PROGRESS.md` still only described the original Plan 03 implementation and old test count. This can mislead follow-on agents into treating stale `plan03review.md` findings as current.

## Rechecked Stale Findings

- `plan03review.md` P1 generic identifier references: no longer current; fixed and tested.
- `plan03review.md` P1 copied server WASM path: no longer current; fixed and tested.
- `plan03review.md` P2 multi/array declarators: no longer current; fixed and tested.

## Vulnerability Check

`npm install --package-lock-only` reported audit findings in the full dependency graph. Production/runtime audit was checked separately with `npm audit --omit=dev --json` and reported 0 production vulnerabilities.

## Deferred Follow-up

- Make pragma reference scanning block-comment aware before Plan 13.
- Decide whether to commit or remove the currently untracked `plan03review.md`; `plan03fix.md` references it, but it is not tracked in this workspace.
