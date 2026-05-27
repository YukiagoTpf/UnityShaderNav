# User Guide

UnityShaderNav adds navigation features for Unity ShaderLab and HLSL files in
VS Code.

## Features

### Go to Definition

Use F12 or VS Code's `Go to Definition` command on:

- HLSL function calls.
- Local variables, parameters, and globals.
- Struct type names and receiver-typed struct members.
- `#include` paths.
- `#pragma vertex`, `#pragma fragment`, and `#pragma kernel` entry points.
- Macro names declared with `#define`.
- Symbols declared through supported Unity declaration macros.

When multiple definitions are valid, UnityShaderNav returns all candidates and
lets VS Code show Peek Definition. This is expected for preprocessor branches,
overload-like HLSL shapes, and repeated pass entry point names.

### Find References

Use Shift+F12 to find references in indexed user files. Package references are
disabled by default because they can be noisy in large URP/HDRP projects.

Enable package references with:

```jsonc
{
  "unityShaderNav.findReferences.includePackages": true
}
```

### Completion And Signature Help

Completion and signature help are backed by the project index. In HLSL/CG code,
UnityShaderNav can suggest indexed project symbols and show signatures for
visible project functions.

The behavior is intentionally conservative: ambiguous overload-like or
preprocessor-dependent functions may appear as multiple signature candidates,
and built-in Unity/HLSL function signatures are not provided yet.

### Document Symbols

Use Ctrl+Shift+O to view ShaderLab blocks, passes, pragmas, functions, structs,
and cbuffer entries in the current file.

### Semantic Coloring

The language server provides semantic tokens for common HLSL and ShaderLab
symbols, including types, variables, parameters, members, functions, and macros.

## Project Detection

The extension tries to find a Unity project root by locating a directory with
both `Assets/` and `ProjectSettings/`. If your VS Code workspace is not the Unity
project root, set `unityShaderNav.projectRoot` manually.

In standalone mode, same-file navigation continues to work, but cross-file
include and package navigation are disabled.

## Cache

The index cache is stored in:

```text
<UnityProject>/Library/UnityShaderNavCache/
```

Deleting `Library/` or this cache directory is safe. The extension will rebuild
the index on the next activation.
