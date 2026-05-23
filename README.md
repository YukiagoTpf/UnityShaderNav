# UnityShaderNav

VSCode extension for Unity Shader files (`.shader`, `.hlsl`, `.cginc`, `.hlslinc`, `.compute`) that provides code navigation for ShaderLab + HLSL projects.

## Features

- F12 definitions for functions, variables, parameters, locals, `#include` paths, `#pragma vertex|fragment|kernel` entry points, and macro declarations.
- Cross-file navigation across user files and Unity `Packages/` resolved from `packages-lock.json`.
- Multi-candidate Peek for same-name symbols across passes, overload-like branches, or multiple files.
- Struct member chain lookup for common explicit-type receivers.
- `#define` navigation from macro usage to the defining directive.
- Ctrl+Shift+O / Document Symbols outline for ShaderLab blocks, HLSL functions, structs, cbuffer entries, and pragmas.
- Shift+F12 Find References across indexed user files, with an opt-in switch to include package references.
- Incremental indexing, rebuild-on-project-metadata changes, and cache persistence under `Library/UnityShaderNavCache/`.

## Settings

- `unityShaderNav.projectRoot`: explicit Unity project root. Empty means autodetect from `Assets/` + `ProjectSettings/`.
- `unityShaderNav.includeDirectories`: extra include search paths.
- `unityShaderNav.excludePatterns`: glob patterns skipped during user-file indexing.
- `unityShaderNav.declarationMacros`: custom macro patterns that declare symbols.
- `unityShaderNav.findReferences.includePackages`: include `Packages/` references in Shift+F12 results. Defaults to `false`.

## Known Limits

- Preprocessor conditions are not evaluated; all branches are indexed.
- Macro bodies are not expanded beyond supported declaration/reference patterns.
- ShaderGraph generated code is not indexed as a special source.
- Surface Shader implicit parameters are not inferred.
