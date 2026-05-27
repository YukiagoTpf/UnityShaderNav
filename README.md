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
- Conservative project-symbol completion and signature help for indexed HLSL/CG
  code.
- Document Symbols and semantic coloring for ShaderLab and HLSL files.
- Unity Package resolution through `Packages/packages-lock.json`.
- Persistent project-local indexing under `Library/UnityShaderNavCache/`.

## Status

This project is in early public-preview shape. The core language server is
working and covered by unit and VS Code integration tests, but Marketplace
publishing, icon polish, CI cache tuning, and a few Unity path edge cases are
still tracked in [GitHub Issues](https://github.com/YukiagoTpf/UnityShaderNav/issues).

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
cd unity-shader-nav
npm install
npm run build
```

To run the extension from source:

1. Open `unity-shader-nav/` in VS Code.
2. Press F5 and choose the extension launch configuration.
3. In the Extension Development Host, open a Unity project.
4. Open a `.shader`, `.hlsl`, `.cginc`, `.hlslinc`, or `.compute` file.

To package a local VSIX:

```powershell
cd unity-shader-nav
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
- [Roadmap](docs/roadmap.md)
- [Technical Spec](docs/technical-spec.md)
- [Architecture Decision Records](docs/adr/)

## Known Limits

- Preprocessor conditions are not evaluated; multiple valid definitions can be
  returned through VS Code Peek Definition.
- Macro bodies are not expanded. Built-in and user-configured declaration
  patterns cover common Unity macro declarations.
- Surface Shader implicit parameters and ShaderGraph generated code are not
  indexed as special sources.
- Completion and signature help are project-index-backed and do not yet provide
  exhaustive Unity or HLSL built-in vocabulary.
- Chain lookup intentionally stays conservative for multiline receivers,
  macro-expanded receivers, branch-dependent types, and overload-specific return
  type inference.

## Contributing

Bug reports, focused repro cases, and small pull requests are welcome. Please
start with [CONTRIBUTING.md](CONTRIBUTING.md), then check the current
[issue tracker](https://github.com/YukiagoTpf/UnityShaderNav/issues).

## License

UnityShaderNav is released under the [MIT License](LICENSE).
