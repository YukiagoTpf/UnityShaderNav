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
- Shader names referenced by `Fallback` or the shader segment of `UsePass`.
- Pass names referenced by the final segment of `UsePass`.

When multiple definitions are valid, UnityShaderNav returns all candidates and
lets VS Code show Peek Definition. This is expected for preprocessor branches,
overload-like HLSL shapes, and repeated pass entry point names.

F12 on a ShaderLab property name (for example `_MainTex` in `Properties { ... }`)
jumps to the HLSL/CG declaration of the same name, when one is visible from the
current shader. F12 on the HLSL declaration or reference also surfaces the
matching property entry. When several declarations share the name, VS Code's
Peek menu lists every candidate without picking one — the resolver remains
conservative (see [ADR-0001](adr/0001-multi-candidate-peek-for-ambiguous-symbols.md)).

### Hover

Pause the mouse over (or press `Ctrl+K Ctrl+I` on) an indexed shader symbol to
see a declaration-style summary and source location. Hover covers project
functions, structs, struct members, variables, parameters, macros, and
ShaderLab Shader/Pass names, plus selected built-ins from the curated catalog.
Ambiguous symbols are listed
without ranking, matching Go to Definition behavior; very large candidate sets
are truncated with a `… and N more candidates` footer to keep the bubble
readable.

### Find References

Use Shift+F12 to find references in indexed user files. Package references are
disabled by default because they can be noisy in large URP/HDRP projects.
Shader declarations are connected to `Fallback` and the shader segment of
`UsePass`; Pass `Name` declarations are connected to the final `UsePass`
segment.

Enable package references with:

```jsonc
{
  "unityShaderNav.findReferences.includePackages": true
}
```

### Problems Diagnostics

UnityShaderNav reports an error on an unresolved function name in supported
`#pragma vertex`, `fragment`, `geometry`, `hull`, `domain`, `surface`, and
`kernel` directives. Resolution uses the same current file, transitive include
closure, Package mapping, and published live-document attempt as Definition.
Fixing or closing the document clears the Problem; include, settings, Package,
and rebuild publications refresh all open documents.

This rule deliberately proves only that at least one visible function can have
the referenced name. It does not compile stage-specific signatures or evaluate
preprocessor variants. Multiple candidates, a branch-dependent declaration,
or a visible same-name macro suppresses the diagnostic rather than risking a
false error. The diagnostic source is `UnityShaderNav` and its stable code is
`unresolved-entry-point`.

#### SRP Batcher material contracts

When a `.shader` file contains explicit SRP evidence—an SRP render-pipeline tag,
an SRP package include, or an existing `UnityPerMaterial` block—UnityShaderNav
checks supported ShaderLab Properties against that material cbuffer. It reports:

- `srp-batcher-property` when a `Color`, `Vector`, `Float`, `Range`, legacy
  float-backed `Int`, or `Integer` Property is missing from an existing, exact
  `UnityPerMaterial` field inventory;
- `srp-batcher-property-type` when the corresponding field type is incompatible;
- `srp-batcher-layout` when multiple complete, unconditional, exact blocks have
  different ordered field names or types.

Use VS Code's Quick Fix command on a missing Property. The extension inserts a
field only when the file has one complete, unconditional, exactly scanned
`UnityPerMaterial`, one program block, and no includes. It refuses edits when a
declaration already exists outside the cbuffer, multiple material blocks or
Pass-local targets must be coordinated, any include could contribute an unseen
declaration, or conditional, macro-generated, or incomplete content prevents a
safe proof. Explicit `packoffset` participates in layout comparison but also
blocks automatic insertion. An include-free file with one complete local program
can report a wholly absent material block, but does not invent one; cases where
an include or shared block may own the contract stay neutral. Texture resources
are not cbuffer fields and are intentionally out of scope. Files with multiple
SubShaders also stay neutral because an untagged Built-in fallback must not be
mixed with an SRP-specific contract before per-SubShader ownership is known.

### Rename

Use F2 or VS Code's `Rename Symbol` command on an indexed HLSL/CG function,
struct, struct member, parameter, local/global variable, macro, or cbuffer.
Rename updates the declaration and the references that resolve to that exact
declaration, including supported `#pragma vertex`, `#pragma fragment`, and
`#pragma kernel` entry-point references.

Rename intentionally refuses the operation when it cannot prove one declaration
identity. This includes overload-like or preprocessor ambiguity, built-ins,
include paths, Package declarations, and HLSL variables linked to ShaderLab
Properties. It also refuses a new name that is not an HLSL identifier or that
conflicts with a visible indexed symbol. ShaderLab Property Rename remains a
separate capability; UnityShaderNav does not perform a partial name-only edit
for that cross-language contract.

ShaderLab Shader and Pass names use the same conservative rule. Shader Rename
updates the declaration plus matching `Fallback` and `UsePass` shader segments.
Pass Rename updates its `Name` declaration and matching `UsePass` pass segments;
the reference segments are written in Unity's canonical uppercase form. A
duplicate Shader name or duplicate Pass name within one Shader is returned as
multiple Definition candidates and blocks Rename.
External and Unity built-in Shader/Pass paths without an indexed declaration
remain neutral: they do not acquire guessed navigation, Hover, References, or
Rename behavior.

### Completion And Signature Help

Completion and signature help are backed by the project index. In HLSL/CG code,
UnityShaderNav can suggest indexed project symbols and show signatures for
visible project functions. It also includes a curated built-in vocabulary for
common HLSL intrinsics, common Unity/URP helper names and macros, common
semantics, and common ShaderLab states and values.

The behavior is intentionally conservative: ambiguous overload-like or
preprocessor-dependent functions may appear as multiple signature candidates,
the built-in vocabulary is not exhaustive, and project symbols are preferred
when names collide with built-ins. On a later argument, Signature Help focuses
the first candidate with enough parameters while keeping every conservative
candidate available. Member completion follows the current file's transitive
include chain and excludes unrelated indexed files.

Inside an unfinished `Fallback "...` value, Completion suggests indexed Shader
names. Inside `UsePass`, it first suggests Shader paths and then the named
passes belonging to the selected Shader. Shader and Pass declarations also
participate in Workspace Symbols (Ctrl+T / Cmd+T).

### Document Symbols

Use Ctrl+Shift+O to view ShaderLab blocks, passes, pragmas, functions, structs,
and cbuffer entries in the current file. ShaderLab structure is derived from the
same exact source snapshot as indexing; Pass-like text and braces inside
multiline comments or string literals do not create or reshape Outline nodes.

### Semantic Coloring

The language server provides semantic tokens for common HLSL and ShaderLab
syntax. In `.shader` files this includes ShaderLab block keywords, Properties
entries and types (including `2DArray` and `CubeArray`), Tags keys and values,
render-state and `UsePass` directives, HLSL preprocessor directives and include
paths, macro-style declarations, shader semantics, members, functions,
swizzles, and indexed project symbols.

Semantic coloring depends on the active VS Code theme. Themes with semantic
highlighting disabled or sparse semantic token rules may show less visible
separation between token categories.

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
