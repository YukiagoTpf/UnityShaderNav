# UnityShaderNav

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

UnityShaderNav is a Visual Studio Code extension for navigating Unity shader
projects. It understands ShaderLab wrappers, HLSL/CG include files, Unity
Packages, declaration macros, and the kinds of symbol ambiguity that are common
in URP/HDRP projects.

The extension focuses on fast code navigation:

- Go to Definition for functions, locals, parameters, structs, struct members,
  macros, `#include` paths, and shader entry points.
- Find References across indexed user files, with an option to include package
  references.
- Workspace Rename for unambiguous indexed HLSL/CG symbols, including pragma
  entry-point references, with conservative refusal for overload-like or
  preprocessor ambiguity.
- Project-wide ShaderLab name intelligence for `Shader`, `Fallback`, `Name`,
  and `UsePass`: Definition, References, Hover, Completion, Workspace Symbols,
  and conservative Rename. `UsePass` pass segments follow Unity's uppercase
  canonical form.
- Hover for declarations of indexed shader symbols (functions, structs,
  members, variables, parameters, macros) and selected built-ins.
- Conservative completion and signature help for indexed HLSL/CG code, plus a
  curated Unity/HLSL/ShaderLab/URP/HDRP built-in vocabulary covering common
  intrinsics, helper macros, render states, and semantics.
- Document Symbols and semantic coloring for ShaderLab wrappers, Properties,
  Tags, render states, preprocessor lines, and HLSL symbols.
- Workspace symbol search (Ctrl+T / Cmd+T) across indexed shader functions,
  structs, struct members, cbuffers, macros, and globals. Package symbols are
  excluded by default and follow `findReferences.includePackages`.
- Conservative dimming of inactive and variant-dependent `#if`/`#ifdef`
  preprocessor branches (presentation only; navigation is unaffected).
- Unity Package resolution through `Packages/packages-lock.json`.
- Persistent project-local indexing under `Library/UnityShaderNavCache/`.

## Status

This project is in public preview. Published builds and release notes are on
[GitHub Releases](https://github.com/YukiagoTpf/UnityShaderNav/releases); current
work is tracked in [GitHub Issues](https://github.com/YukiagoTpf/UnityShaderNav/issues).

## Supported Files

UnityShaderNav activates for:

- `.shader`
- `.hlsl`
- `.cginc`
- `.hlslinc`
- `.compute`

Standalone HLSL files get same-file navigation. Full cross-file navigation
requires a Unity project root containing `Assets/` and `ProjectSettings/`.

## Install

### Option 1: Download the VSIX from Releases

1. Open the [latest release](https://github.com/YukiagoTpf/UnityShaderNav/releases/latest).
2. Download `unity-shader-nav-*.vsix` from the release assets.
3. In VS Code, open the Extensions view.
4. Choose `...` -> `Install from VSIX...`.
5. Select the downloaded VSIX file.

After installation, open a Unity project and then open a `.shader`, `.hlsl`,
`.cginc`, `.hlslinc`, or `.compute` file.

### Option 2: Build from Source

Use this path if you want to develop the extension or package a local build.

Requirements:

- VS Code 1.85 or newer
- Node.js 18 or newer
- npm

```powershell
npm ci
npm run build
```

To run the extension from source:

1. Open the repository root in VS Code.
2. In a terminal, run `npm run watch` and wait for `[watch-runtime] build ok`.
3. Press F5 and choose the extension launch configuration.
4. In the Extension Development Host, open a Unity project.
5. Open a `.shader`, `.hlsl`, `.cginc`, `.hlslinc`, or `.compute` file.
6. After source edits, wait for `[watch-runtime] build ok`, then reload the Extension Development Host window.

To package a local VSIX:

```powershell
npm run package:vsix
```

## Configuration

Common settings:

```jsonc
{
  "unityShaderNav.projectRoot": "",
  "unityShaderNav.includeDirectories": [],
  "unityShaderNav.excludePatterns": ["**/Library/**", "**/Temp/**", "**/Logs/**"],
  "unityShaderNav.declarationMacros": [],
  "unityShaderNav.findReferences.includePackages": false
}
```

See [Configuration](docs/configuration.md) for the full explanation and examples.

## Documentation

- [User Guide](docs/usage.md)
- [Configuration](docs/configuration.md)
- [Development Guide](docs/development.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Technical Spec](docs/technical-spec.md)
- [Architecture Decision Records](docs/adr/)

## Known Limits

- Preprocessor conditions are not evaluated; multiple valid definitions can be
  returned through VS Code Peek Definition.
- Macro bodies are not expanded. Built-in and user-configured declaration
  patterns cover common Unity macro declarations.
- Surface Shader implicit parameters and ShaderGraph generated code are not
  indexed as special sources.
- Built-in completion and signature help are curated and non-exhaustive.
  Project symbols are preferred when names collide with built-ins.
- Chain lookup intentionally stays conservative for multiline receivers,
  macro-expanded receivers, branch-dependent types, and overload-specific return
  type inference.
- Rename requires a unique indexed declaration identity. ShaderLab Properties,
  built-ins, Package declarations, and ambiguous Shader, Pass, or HLSL
  candidates are intentionally refused rather than edited by name.
- ShaderLab name intelligence is declaration-backed and limited to `Fallback`
  and `UsePass`; external or Unity built-in names without an indexed declaration
  stay unresolved rather than being guessed from a catalog.

## Contributing

Bug reports, focused repro cases, and small pull requests are welcome. Please
start with [CONTRIBUTING.md](CONTRIBUTING.md), then check the current
[issue tracker](https://github.com/YukiagoTpf/UnityShaderNav/issues).

## License

UnityShaderNav is released under the [MIT License](LICENSE).
