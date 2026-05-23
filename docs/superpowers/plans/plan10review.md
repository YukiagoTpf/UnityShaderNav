# Plan 10 Code Review

Date: 2026-05-23

Reviewer: code-review subagent (`Copernicus`)

Scope: `060fb0c..15ab7a9`

## Findings

### P2 - Struct members can be attached across same-named structs in different Pass blocks

File: `unity-shader-nav/server/src/index/documentSymbols.ts`

`buildHlslSymbols()` groups `structMember` entries by `parentType` only. In `.shader` files, separate HLSL blocks can redeclare common struct names such as `Attributes` or `Varyings`. Members from all same-named structs can then attach to every struct symbol. Because `rangeWithChildren()` expands the struct range across those members, the struct may no longer fit inside its owning Pass and can disappear from Pass-level nesting.

Required fix: bind struct members to the nearest preceding same-named struct declaration, or otherwise use line locality so each struct only receives members from its own declaration block.

### P2 - Cache version was not invalidated for the new `FileIndex.structure` field

Files:
- `unity-shader-nav/shared/src/symbols.ts`
- `unity-shader-nav/shared/src/cache.ts`
- `unity-shader-nav/server/src/workspace/workspace.ts`

Plan 10 adds `FileIndex.structure`, but Plan 09 cache manifests can still restore older `.shader` indexes without that field. Warm cache restore would make document symbols fall back to flat HLSL output until a file is reindexed.

Required fix: bump `CACHE_VERSION` so old manifests are ignored.

### P2 - Document symbol handler bypasses request suspension and lazy workspace creation

File: `unity-shader-nav/server/src/handlers/documentSymbol.ts`

The handler uses synchronous `workspaceFor()` and directly reads the store. Definition requests already use `RequestSuspender` and `workspaceForOrCreateFile()` so cold start, rebuild, and standalone lazy workspace creation are handled consistently. Outline can otherwise return `null` during these windows, and VSCode may not reliably retry.

Required fix: make the handler async, use `workspaceForOrCreateFile()`, and run through `RequestSuspender` when provided.

## Verdict

Fix subagent required before updating Plan 10 progress.
