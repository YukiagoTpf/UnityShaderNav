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
  highlights, hover, completion, signature help, semantic tokens,
  inactive-region dimming, and open-document behavior.
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
- Preprocessor conditions are not evaluated for navigation, references, or
  completion. A separate presentation-only layer does apply conservative
  preprocessor branch dimming (inactive and variant-gated `#if`/`#ifdef`/
  `#ifndef` branches are visually dimmed via client decorations), but it never
  changes index results. See
  [ADR-0005](adr/0005-conservative-preprocessor-branch-dimming.md).

## Package Resolution

Unity package includes are resolved from `Packages/packages-lock.json`. This
avoids scanning stale package cache folders and matches Unity's resolved package
state. See [ADR-0002](adr/0002-manifest-driven-package-indexing.md).

### Supported `packages-lock.json` source forms

| `source`   | Required fields              | Resolved location                                                  |
| ---------- | ---------------------------- | ------------------------------------------------------------------ |
| `embedded` | `version: "file:<dir>"`      | `Packages/<dir>` under the project root                            |
| `local`    | `version: "file:<path>"`     | `<path>` (absolute) or `Packages/<path>` (relative)                |
| `registry` | `version`, optional `hash`   | `Library/PackageCache/<name>@<hash \|\| version>`                  |
| `builtin`  | `version`                    | `Library/PackageCache/<name>@<version>`                            |
| `git`      | `version: "<scheme>..."`, `hash` | `Library/PackageCache/<name>@<hash[:10]>` for `git+https`, `git+http`, `git+ssh`, and bare `https://...?path=` subpath URLs |

Unity 2022.3 truncates the lockfile `hash` (a 40-character commit SHA) to the
first 10 characters when naming the cache directory, so the resolver does the
same. `?path=` subpath git packages share this naming convention — Unity
extracts only the requested subdirectory into the cache folder, so the resolved
path still points at the package root. Verified against Unity 2022.3.53f1c1
(issue #25). Unknown sources and `git` entries without a `hash` are skipped
with a console warning rather than being guessed.

## Cache

The workspace index is persisted under `Library/UnityShaderNavCache/` with a
cache version and source fingerprint. In standalone mode, cache storage falls
back to VS Code global storage. See
[ADR-0004](adr/0004-persist-index-cache-under-library.md).
