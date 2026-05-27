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

## Near-Term Navigation And Authoring Issues

These low-risk, high-value editor improvements are now tracked as GitHub Issues:

- [Add hover information for shader symbols](https://github.com/YukiagoTpf/UnityShaderNav/issues/18).
- [Add workspace symbol search for indexed shader symbols](https://github.com/YukiagoTpf/UnityShaderNav/issues/19).
- [Navigate from ShaderLab Properties to HLSL declarations](https://github.com/YukiagoTpf/UnityShaderNav/issues/20).
- [Expand curated Unity/HLSL built-in completion and signature vocabulary](https://github.com/YukiagoTpf/UnityShaderNav/issues/21).

## Candidate Future Work

Candidate work here should become GitHub Issues once the implementation path is
small enough to verify independently.

- Marketplace release automation.

## Later Planning

### Medium-Risk Core Enhancements

These features extend the existing navigation model, but need real-project
fixtures and careful UX boundaries before becoming implementation issues:

- Smarter include and shader-context selection for preprocessor-heavy projects.
- Additional macro declaration patterns from production shaders.
- URP/HDRP context inference that improves navigation without pretending to be a
  full shader compiler.

### High-Risk Product Tracks

These are larger product directions that may require new architecture,
integration points, or explicit non-goal revisions:

- Preprocessor-aware context and variant modeling.
- Shader diagnostics or compiler integration.
- C# to shader cross-language navigation.
- ShaderGraph generated-code modeling.
- Rider-style shader context selection.

## What Is Intentionally Out of Scope For Now

- Full C preprocessor expansion.
- Shader compilation, preview, or diagnostics.
- C# to shader cross-language navigation.
- ShaderGraph generated-code modeling.
- Surface Shader implicit parameter synthesis.
