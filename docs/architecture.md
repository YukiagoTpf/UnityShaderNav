# Architecture

UnityShaderNav is a VS Code extension backed by a separate language server.

```text
VS Code extension client
  -> vscode-languageclient
  -> language server process
     -> ShaderLab block scanner
     -> tree-sitter HLSL parser
     -> macro pattern recognizer
     -> per-file symbol/reference indexes
     -> workspace/global indexes
     -> LSP handlers
```

## Client

The client contributes file types, settings, activation events, status output,
and language-client startup. The server is copied into the extension output
during build so the packaged extension can launch it.

## Server

The server owns parsing, indexing, cache restore/persist, and LSP request
handling. Important modules:

- `parser/shaderlab`: scans ShaderLab and extracts HLSL/CG blocks.
- `parser/hlsl`: wraps tree-sitter and collects symbols/references.
- `macros`: recognizes built-in and user-configured declaration/reference
  patterns.
- `include` and `packages`: resolve relative includes and Unity Package paths.
- `index`: stores symbols, references, visibility, and chain lookup data.
- `suggestions`: classifies completion/signature contexts, enumerates visible
  project symbols, formats LSP completion/signature items, and filters curated
  built-in shader vocabulary.
- `handlers`: implements definition, references, document symbols, document
  highlights, completion, signature help, semantic tokens, and open-document
  behavior.
- `workspace`: detects Unity roots, scans files, watches changes, and manages
  persistent cache.

## Indexing Model

The index is intentionally pragmatic:

- Symbols are name-based and allow multiple candidates.
- Local variables and parameters carry scope ranges.
- Cross-file search is constrained by include-chain visibility where possible.
- Struct member navigation infers receiver type from declarations and narrow
  assignment facts rather than a full type system.
- Completion and signature help reuse the same index and include-visibility
  rules as navigation, then merge curated built-ins only after project symbols.
- Preprocessor conditions are not evaluated.

## Package Resolution

Unity package includes are resolved from `Packages/packages-lock.json`. This
avoids scanning stale package cache folders and matches Unity's resolved package
state. See [ADR-0002](adr/0002-manifest-driven-package-indexing.md).

## Cache

The workspace index is persisted under `Library/UnityShaderNavCache/` with a
cache version and source fingerprint. In standalone mode, cache storage falls
back to VS Code global storage. See
[ADR-0004](adr/0004-persist-index-cache-under-library.md).
