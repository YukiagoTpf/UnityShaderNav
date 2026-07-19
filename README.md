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
- Adapter-backed navigation for File-mode Shader Graph Custom Function nodes:
  F12 opens the precision-suffixed HLSL declaration, Find References returns to
  graph nodes, and Problems identifies missing includes, invalid suffixes, and
  port/signature mismatches.
- Workspace Rename for unambiguous indexed HLSL/CG symbols, including pragma
  entry-point references and same-file ShaderLab Property contracts, with
  conservative refusal for overload-like or preprocessor ambiguity.
- Project-wide ShaderLab name intelligence for `Shader`, `Fallback`, `Name`,
  and `UsePass`: Definition, References, Hover, Completion, Workspace Symbols,
  and conservative Rename. `UsePass` pass segments follow Unity's uppercase
  canonical form.
- VS Code Problems diagnostics for unresolved `#pragma vertex`, `fragment`,
  `geometry`, `hull`, `domain`, `surface`, and `kernel` entry points, refreshed
  from the same live published revision as navigation.
- Conservative SRP Batcher contract diagnostics for scalar/vector ShaderLab
  Properties missing from `UnityPerMaterial`, incompatible field types, and
  deterministic cross-Pass layout drift. A Quick Fix is offered only when one
  exact insertion target is safe.
- Hover for declarations of indexed shader symbols (functions, structs,
  members, variables, parameters, macros), plus sourced Quick Documentation
  for selected ShaderLab terms, Property syntax, semantics, and SRP helpers.
  In Unity projects, `UNITY_VERSION` also shows a presentation-only value
  derived from `ProjectSettings/ProjectVersion.txt`. Project and Package
  declarations win over these version-aware fallbacks.
- Conservative completion and signature help for indexed HLSL/CG code, plus a
  curated Unity/HLSL/ShaderLab/URP/HDRP built-in vocabulary covering common
  intrinsics, helper macros, render states, and semantics. Receiver-aware
  results include texture methods and overload signatures, vector swizzles,
  non-square matrix components, and explicitly typed texture declarations such
  as `Texture2D<float4>`.
- Context-scoped ShaderLab snippets for complete Surface and vertex/fragment
  Shaders, common Material Properties, Pass/program structures, and Blend
  states; editable presentations for normalized literal Color defaults; and
  safe ShaderLab indentation formatting.
- Document Symbols and semantic coloring for ShaderLab wrappers, Properties,
  Tags, render states, preprocessor lines, and HLSL symbols.
- Workspace symbol search (Ctrl+T / Cmd+T) across indexed shader functions,
  structs, struct members, cbuffers, macros, and globals. Package symbols are
  excluded by default and follow `findReferences.includePackages`.
- Conservative dimming of inactive and variant-dependent `#if`/`#ifdef`
  preprocessor branches, with a theme-adaptive marker distinguishing variant
  gates from definitely inactive code (presentation only; navigation is
  unaffected).
- Optional variant-context picker (status bar + QuickPick) to resolve
  `multi_compile` / `shader_feature` ambiguity: active branches brighten,
  inactive ones dim, and active navigation candidates rank first while every
  conservative candidate remains available. Opt-in; default behaviour is
  unchanged.
- Session-only Shader Context picker for shared HLSL/CG includes. Known
  Shader, Pass, stage, and include-point combinations come from one published
  index revision; selecting one sharpens dimming, semantic coloring,
  completion, and diagnostics without narrowing navigation results.
- Adapter-backed Source, Preprocessed, and Generated compiler evidence views
  for one selected Shader Context and verified compile profile. Exact `#line`
  regions navigate in both directions across ShaderLab and includes; macro
  expansions and generated-only regions stay visibly unmapped. Source changes
  mark old virtual documents `STALE` before replacement evidence arrives.
- Selected Material Context from a connected Unity Editor Adapter. The status
  bar exposes the Material's Shader, optional SubShader/Pass, serialized
  Properties, textures, Material keywords, and provenance; matching source
  candidates rank first while every conservative result remains available.
  This is asset/editor evidence, not the final draw Context, so global and
  engine-added keyword state stays explicitly unknown.
- Declared/static Variant cost CodeLens for explicit `multi_compile` and
  `shader_feature` keyword sets, including per-program upper bounds, scope,
  stage, and largest-multiplier facts without claiming Unity build counts.
- An Adapter-backed **Show Variant Build Comparison** report that keeps
  Declared/static upper bounds, Unity Compile candidates, Kept Variants, and
  unavailable evidence visibly separate per Shader/Pass/Stage/build target,
  with the largest keyword-set gaps first.
- Unity Package resolution through `Packages/packages-lock.json`.
- Persistent project-local indexing under `Library/UnityShaderNavCache/`.

## Status

This project is in public preview. Install the latest build from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Yukiago.unity-shader-nav),
or download it with its release notes from
[GitHub Releases](https://github.com/YukiagoTpf/UnityShaderNav/releases). Current
work is tracked in [GitHub Issues](https://github.com/YukiagoTpf/UnityShaderNav/issues).

## Supported Files

UnityShaderNav activates for:

- `.shader`
- `.hlsl`
- `.cginc`
- `.hlslinc`
- `.compute`
- `.shadergraph` (File-mode Custom Function navigation requires a compatible
  Unity Editor Adapter)

Standalone HLSL files get same-file navigation. Full cross-file navigation
requires a Unity project root containing `Assets/` and `ProjectSettings/`.

## Install

### Option 1: Install from the Visual Studio Marketplace

1. Open [UnityShaderNav on the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Yukiago.unity-shader-nav).
2. Select **Install** and let VS Code complete the installation.

### Option 2: Download the VSIX from Releases

1. Open the [latest release](https://github.com/YukiagoTpf/UnityShaderNav/releases/latest).
2. Download `unity-shader-nav-*.vsix` from the release assets.
3. In VS Code, open the Extensions view.
4. Choose `...` -> `Install from VSIX...`.
5. Select the downloaded VSIX file.

After installation, open a Unity project and then open a `.shader`, `.hlsl`,
`.cginc`, `.hlslinc`, `.compute`, or `.shadergraph` file.

### Option 3: Build from Source

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
5. Open a `.shader`, `.hlsl`, `.cginc`, `.hlslinc`, `.compute`, or
   `.shadergraph` file.
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

- Preprocessor conditions are not evaluated by default; multiple valid
  definitions can be returned through VS Code Peek Definition. The optional
  Variant Context picker can resolve declared `multi_compile` / `shader_feature`
  keywords for presentation and candidate ordering, but this is user-driven
  and does not constitute compiler-accurate variant resolution. Shared include
  files can additionally select one known Shader include-point Context; it is
  revision-bound, session-only, and falls back to Auto after publication.
- Material Context requires a connected Adapter and a selected persistent
  Material asset. It is invalidated on reconnect, selection changes, asset
  deletion, or source/content-hash mismatch. It does not claim renderer,
  camera, platform, graphics API, global keyword, or engine-added keyword state
  without actual draw evidence.
- Variant build comparison requires a connected Editor Adapter advertising the
  versioned `variant-build-evidence` capability. Missing, oversized, foreign,
  stale, or source-drifted evidence remains explicitly unavailable; it never
  changes the Declared/static CodeLens or the source index.
- Macro bodies are not expanded. Built-in and user-configured declaration
  patterns cover common Unity macro declarations. Compiler evidence maps only
  unchanged lines whose `#line` source name resolves to one hash-identified
  snapshot; expanded lines remain visible mapping gaps rather than approximate
  locations.
- Surface Shader implicit parameters and Shader Graph generated code are not
  indexed as special sources. File-mode Custom Function navigation consumes
  only version-supported logical facts from the Unity Editor Adapter; when the
  Adapter or capability is unavailable, raw `.shadergraph` serialization is
  never guessed and the feature stays neutral.
- Built-in completion and signature help are curated and non-exhaustive.
  Receiver members are offered only when an indexed declaration supplies a
  supported type; project symbols are preferred when names collide with
  built-ins.
- Quick Documentation is curated and non-exhaustive. Package-specific fallback
  appears only for a compatible, include-visible built-in or default-registry
  Unity Package. Unity-scoped prose is currently verified for Editor 2022.3;
  other and unknown Editor versions keep the fallback with an explicit
  verification note. Scoped-registry, forked, local, and incompatible Package
  facts remain neutral unless an actual indexed declaration is available.
- Color presentations exclude HDR, Vector, expressions, and out-of-range
  components. Formatting changes only leading ShaderLab indentation, preserves
  complete embedded program/include blocks byte-for-byte, and refuses malformed
  structure. HLSL formatting is out of scope.
- Chain lookup intentionally stays conservative for multiline receivers,
  macro-expanded receivers, branch-dependent types, and overload-specific return
  type inference.
- Rename requires a unique indexed declaration identity. ShaderLab Property
  edits stay inside the selected `.shader` file and include at most one matching
  HLSL/CG declaration plus its proven references. Built-ins, Package
  declarations, include-supplied Property contracts, and ambiguous Shader,
  Pass, or HLSL candidates are intentionally refused rather than edited by name.
- ShaderLab name intelligence is declaration-backed and limited to `Fallback`
  and `UsePass`; external or Unity built-in names without an indexed declaration
  stay unresolved rather than being guessed from a catalog.
- Entry-point diagnostics prove name visibility only; they do not compile
  signatures or preprocessor variants. Any visible function, ambiguity, or
  same-name macro suppresses the error to avoid false positives.
- SRP Batcher checks require explicit SRP evidence and cover `Color`, `Vector`,
  `Float`, `Range`, legacy float-backed `Int`, and `Integer` Properties. Texture
  resources, conditional or macro-generated cbuffer layouts, and ambiguous
  multi-block edits stay neutral or require manual repair. Multi-SubShader files
  stay neutral until per-SubShader pipeline ownership can be proven.

## Contributing

Bug reports, focused repro cases, and small pull requests are welcome. Please
start with [CONTRIBUTING.md](CONTRIBUTING.md), then check the current
[issue tracker](https://github.com/YukiagoTpf/UnityShaderNav/issues).

## License

UnityShaderNav is released under the [MIT License](LICENSE).
