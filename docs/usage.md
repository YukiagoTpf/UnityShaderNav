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
Selected ShaderLab directives, render states, Property attributes and types,
HLSL semantics, and SRP helpers also provide Quick Documentation with a public
source and an explicit Unity or Package version scope. An indexed project or
Package declaration always wins. Package-specific curated text appears only
when the owning built-in or default-registry Unity Package is include-visible
and its resolved manifest version is supported. Unity-scoped entries are
currently verified for Editor 2022.3, read from
`ProjectSettings/ProjectVersion.txt`. Other and unknown Editor versions keep
the fallback with an explicit verification note. Scoped-registry, local,
forked, or incompatible Package facts stay neutral. The catalog is
intentionally useful rather than exhaustive.

In HLSL/CG code, Hover on `UNITY_VERSION` shows a presentation-only value
derived from the captured `ProjectSettings/ProjectVersion.txt`. Representable
Editor versions use Unity's documented numeric encoding. Version shapes outside
those exact fields—including older LTS patch numbers that exceed the documented
single patch digit—show an explicit major/minor prefix instead of inventing an
exact value. Unknown projects remain neutral, indexed `#define` declarations
still win, and this display does not feed the preprocessor evaluator.

Ambiguous symbols are listed without ranking, matching Go to Definition
behavior; very large candidate sets are truncated with a `… and N more
candidates` footer to keep the bubble readable.

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
include paths, and Package declarations. It also refuses a new name that is not
an HLSL identifier or that conflicts with a visible indexed symbol.

For a ShaderLab Property, Rename edits the Property declaration and, when
present, one matching HLSL/CG declaration plus the references proven to resolve
to it in the same `.shader` file. The same edit is available when Rename starts
from that HLSL/CG declaration or one of its references. Multiple same-name
Property or HLSL/CG declarations remain ambiguous; declarations supplied by an
include are outside this file-local contract. C# strings, Material assets, and
other cross-asset references are not edited.

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

### ShaderLab Authoring Assistance

Completion also exposes snippets only in their direct, structurally valid
ShaderLab scope:

- complete `surf` (Built-in Surface Shader) and `vfshader` templates when the
  document otherwise contains only whitespace;
- Color, Float, Range, Vector, and 2D texture Material Properties inside
  `Properties`;
- `pass` and vertex/fragment `vfpass` skeletons directly inside `SubShader`;
- one pipeline-neutral `HLSLPROGRAM` vertex/fragment skeleton directly inside
  a Pass that does not already contain a program block;
- editable alpha, additive, premultiplied-alpha, and multiply `Blend` states
  directly inside a Pass, whether or not the Pass already has a program block.

Property snippets declare only the Material-facing Property; they do not claim
to synchronize an HLSL variable or `UnityPerMaterial` field. `surf` explicitly
targets the Built-in Render Pipeline. The vertex/fragment templates deliberately
leave the object-to-clip expression editable rather than guessing Built-in,
URP, or HDRP ownership. Structural and lexical gates prevent every ShaderLab
snippet from appearing inside HLSL/CG program blocks.

VS Code shows a color decoration and picker for a `Color` Property default only
when it is an exact, non-HDR four-number tuple with every component in `[0, 1]`.
`Vector`, HDR, expressions, and out-of-range values stay neutral. Applying a
presentation writes another ShaderLab tuple over that exact current range.

Format Document changes only deterministic leading indentation outside embedded
HLSL/CG program and include blocks. Those blocks, including their marker lines,
remain byte-for-byte unchanged. Unbalanced braces, comments, or program markers
cause formatting to return no edits. HLSL formatting, range formatting,
trailing-whitespace cleanup, and whole-file rewriting are intentionally out of
scope.

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

### Variant Context

Unity shaders use `#pragma multi_compile` / `shader_feature` to declare variant
keywords, and `#ifdef` / `#if defined()` to branch code on them. By default,
UnityShaderNav treats every variant branch as equally valid: variant-gated
branches are dimmed with a theme-adaptive "variant" marker, and F12 returns
every candidate from every branch for you to pick from in Peek Definition.

The **Variant Context** status-bar item lets you opt into a specific set of
active keywords for the current document:

- Click the `Variants: N/off` status-bar item (shown for `.shader` / `.hlsl`
  files) to open a QuickPick listing every `multi_compile` / `shader_feature`
  keyword the document declares.
- Toggle keywords on/off. The chosen set is sent to the server as the active
  `VariantContext`.
- **Dimming**: branches gated by an active keyword brighten (no longer dimmed);
  branches gated by an inactive keyword dim as "inactive" (definitely off in
  this context). Branches gated by unknown macros stay visible (conservative).
- **F12 / Find References**: when the context makes exactly one branch active,
  navigation jumps directly to it (no Peek). When several branches remain
  active, all are returned. When the context rules out every candidate, all are
  returned (never an empty result).
- **Clear (conservative)**: removes the context and restores the default
  behaviour.

The selection is kept in memory for the editor session; it is not persisted
across restarts. No settings are required. The feature is purely opt-in —
opening the picker is never required, and the default behaviour is unchanged.

This is a user-driven, presentation/navigation-narrowing aid, not a
compiler-accurate variant resolver. It covers only the keywords the document
itself declares; platform defines and material/global keyword state are out of
scope. The selection does not enumerate the combinations shown by the separate
declared-cost presentation below.

### Declared Variant Cost

VS Code shows a CodeLens above each supported `#pragma multi_compile` or
`#pragma shader_feature` keyword set. The lens labels the value as
**Declared/static**, shows the normalized set multiplier, global/local scope,
all-stage or stage-specific suffix, and the containing program's upper bound.
An additional lens on each `HLSLPROGRAM` / `CGPROGRAM` marker shows that
program's upper bound, number of unique sets, and largest multiplier. In a raw
HLSL or Compute document, the file is the one document-local program. Every
lens is clickable and opens this explanation.

The estimate has one deterministic contract:

- Exact `multi_compile`, `shader_feature`, their `_local` forms, and the
  `_vertex`, `_fragment`, `_hull`, `_domain`, `_geometry`, and `_raytracing`
  suffixes are supported. Built-in `multi_compile_*` shortcuts are not expanded.
- A `multi_compile` multiplier is its number of unique declared options. One or
  more underscores are one blank/off option. A single-named-option
  `shader_feature` has Unity's implicit blank/off option; sets with two or more
  named options need an explicit underscore. Repeated options on one line are
  normalized.
- Unity does not permit the same normalized keyword set twice in one program;
  the estimate therefore shows every duplicate declaration but lets later
  copies contribute `×1`. Global/local and stage scope are part of that identity,
  so the same names can still describe separate scoped or stage-specific sets.
- All pragmas lexically nested in `#if` / `#ifdef` / `#ifndef` are marked
  conditional and included. Mutually exclusive branches can therefore make the
  target-independent static upper bound deliberately high.
- `HLSLINCLUDE` sets contribute to every `HLSLPROGRAM` in the Shader source;
  `CGINCLUDE` does the same for `CGPROGRAM`. A standalone include file remains
  document-local because the CodeLens does not guess which sites use
  `#include_with_pragmas`.
- Products use exact integer arithmetic, so counts beyond JavaScript's safe
  numeric range do not wrap or round. CodeLens pulls from the current open text,
  so unsaved edits replace the count rather than waiting for index publication.

This number is not how many Variants Unity will compile, keep, load, or execute.
Unity can select conditional pragmas per platform, strip unused
`shader_feature` combinations, apply `skip_variants`, inject or strip built-in
keyword families, merge stage behavior for some graphics APIs, and apply render
pipeline or project build settings. External `#include_with_pragmas`
dependencies and invalid declarations are also outside this source-local
calculation. Use Unity's
[shader keyword declaration rules](https://docs.unity3d.com/6000.0/Documentation/Manual/SL-MultipleProgramVariants-declare.html),
[keyword conditional rules](https://docs.unity3d.com/6000.0/Documentation/Manual/SL-MultipleProgramVariants-make-conditionals.html),
[Variant stripping guidance](https://docs.unity3d.com/6000.0/Documentation/Manual/shader-variant-stripping.html),
and [build logs](https://docs.unity3d.com/6000.0/Documentation/Manual/shader-how-many-variants.html)
for compiler and build evidence.

## Project Detection

The extension tries to find a Unity project root by locating a directory with
both `Assets/` and `ProjectSettings/`. If your VS Code workspace is not the Unity
project root, set `unityShaderNav.projectRoot` manually.

In standalone mode, same-file navigation continues to work, but cross-file
include and package navigation are disabled.

## Index Status And Logs

The UnityShaderNav status-bar item shows whether the language server is
starting, indexing, ready, in standalone mode, stopped, or failed. Click a
ready or indexing item to inspect every workspace root. Click a failed item to
open the shared `UnityShaderNav` output channel with the current failure details.
The same actions are available from the Command Palette as
`UnityShaderNav: Show Index Status` and `UnityShaderNav: Show Output`.

## Cache

The index cache is stored in:

```text
<UnityProject>/Library/UnityShaderNavCache/
```

Deleting `Library/` or this cache directory is safe. The extension will rebuild
the index on the next activation.
