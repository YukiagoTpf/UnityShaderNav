# Roadmap

The current public backlog lives in
[GitHub Issues](https://github.com/YukiagoTpf/UnityShaderNav/issues). This file
summarizes the broad direction without duplicating issue implementation plans.

## Current Priorities

- Improve F5 development workflow with a runtime watch/dev script.
- Cache VS Code test downloads in CI.
- Clean stale compiled Electron test output during `npm run clean`.
- Support additional Unity PackageManager path forms.
- Tighten release packaging and GitHub release automation.

## Candidate Future Work

- Expand the curated Unity/HLSL built-in completion vocabulary from real shader
  authoring feedback.
- ShaderLab Properties to HLSL variable navigation.
- Hover information for functions, structs, variables, and macros.
- Workspace symbol search.
- More advanced shader-context selection for preprocessor-heavy projects.
- Additional macro declaration patterns from real production shaders.
- Marketplace release automation.

## What Is Intentionally Out of Scope For Now

- Full C preprocessor expansion.
- Shader compilation, preview, or diagnostics.
- C# to shader cross-language navigation.
- ShaderGraph generated-code modeling.
- Surface Shader implicit parameter synthesis.
