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
- File-mode Custom Function nodes in `.shadergraph` assets, when a compatible
  Unity Editor Adapter supplies the node's logical source, precision, and port
  facts.

When multiple definitions are valid, UnityShaderNav returns all candidates and
lets VS Code show Peek Definition. This is expected for preprocessor branches,
overload-like HLSL shapes, and repeated pass entry point names.

F12 on a ShaderLab property name (for example `_MainTex` in `Properties { ... }`)
jumps to the HLSL/CG declaration of the same name, when one is visible from the
current shader. F12 on the HLSL declaration or reference also surfaces the
matching property entry. When several declarations share the name, VS Code's
Peek menu lists every candidate without picking one — the resolver remains
conservative (see [ADR-0001](adr/0001-multi-candidate-peek-for-ambiguous-symbols.md)).

For an Adapter-backed File-mode Custom Function node, F12 opens the exact HLSL
include declaration named `<Function>_float` or `<Function>_half`. The
declaration must match the node's ordered input/output port signature. The
language server hashes the current graph text to validate the Adapter's saved
asset revision, but never interprets `.shadergraph` serialization itself.

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
segment. References on a matching precision-suffixed HLSL Custom Function also
include Adapter-reported graph node positions whose saved graph revision is
still current.

References on a ShaderLab Property can also include Adapter-reported C# calls
whose exact current source still matches the evidence. Constant string calls
and constant `Shader.PropertyToID` flows are authoritative when the Adapter has
proven their Shader binding. Name-only and dynamic calls remain visible as
explicitly uncertain evidence; they are never treated as safe Rename edits.
Numeric runtime property IDs are not persisted or compared as source identity.
UnityShaderNav reads open C# buffers through VS Code and falls back to the
closed saved file, without registering a C# Definition, References, Rename, or
diagnostics provider.

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

#### Shader Context aggregation

With **Context: Auto**, a shared HLSL/CG file is checked across an explicitly
bounded set of known include-point Contexts from one published revision. The
extension analyzes at most 64 Contexts and groups equivalent findings into one
Problem. Its final line shows the affected and analyzed counts; expanding the
Problem shows the exact Shader, SubShader/Pass, stage, entry point, include
location, keyword facts, and static revision provenance for each affected
Context.

The result is intentionally not a build-success claim. A keyword selection,
platform, graphics API, or unsupported Context that has not been proven is
shown as **unverified**, never as passing. Contexts beyond the cap are counted
as omitted/unverified. Selecting one explicit include-point Context keeps the
existing scoped diagnostic view for investigating that route.

When a connected Unity Editor Adapter exposes compiler profiles, Auto requests
the same bounded profile set. Equivalent Unity messages from several profiles
are grouped while preserving each original `ShaderMessage`, profile, and full
Adapter provenance. A profile that fails, disconnects, or is unsupported stays
visible as unverified beside findings from profiles that completed. Saving a
new revision cancels the superseded profile work; stale results cannot publish.

#### Shader Graph Custom Function contracts

For each supported File-mode Custom Function fact, UnityShaderNav reports:

- `shader-graph-source-missing` when the Adapter-resolved include is absent from
  the published source index;
- `shader-graph-invalid-precision-suffix` when the configured base name is not
  a valid unsuffixed HLSL identifier or the include has no `_float` / `_half`
  declaration selected by the node precision;
- `shader-graph-signature-mismatch` when the declaration's return type, ordered
  parameter names/types, or input/output directions differ from the node ports.

These diagnostics identify the Unity and Shader Graph versions from Adapter
provenance. An unavailable Adapter, an unadvertised capability, a stale graph
revision, or an unsupported Shader Graph version produces no guessed graph
facts or speculative diagnostics. Static ShaderLab/HLSL navigation remains
unchanged.

#### C# Shader Property evidence

For authoritative, source-fresh C# evidence, UnityShaderNav reports
`csharp-property-type-mismatch` when a `Material` or
`MaterialPropertyBlock` Set/Get accessor is incompatible with the ShaderLab
Property type. For example, a texture accessor is incompatible with a `Color`
Property. A constant `Shader.PropertyToID` assignment preserves the Property
name's source identity without using the generated integer value.

Name-only Shader binding and dynamic Property-name expressions produce the
informational `csharp-property-uncertain` diagnostic instead of a type claim.
Stale, malformed, foreign-project, or unsupported Adapter evidence is ignored.
These focused Shader diagnostics do not replace the installed C# extension's
compiler diagnostics.

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

### Custom Shader portability report

Run **UnityShaderNav: Show Custom Shader Portability Report** from an open
`.shader` file. Select either Universal Render Pipeline or an Adapter-advertised
graphics profile. The generated Markdown report records the exact target, the
Unity Editor version captured from `ProjectSettings/ProjectVersion.txt`, and the
resolved render-pipeline Package name, version, source, and official-source
status from the same Published indexed revision as the document.

Every finding has one of four meanings:

| Finding | Meaning | Can be a Quick Fix? |
|---|---|---|
| mechanical change | An exact, source-local syntax edit is known for this version fixture. | Only when the report carries a mechanically proven edit. |
| human rewrite | Pipeline ownership, data flow, lighting, texture/sampler, cbuffer, include, macro, or Pass behavior needs a developer decision. | No. |
| unsupported semantic | The selected target does not implement the source feature, or the target/profile is unavailable. | No. |
| verification requirement | Static facts are insufficient; save and compile the exact source with Unity, then inspect rendered behavior. | No. |

The first render-pipeline slice recognizes only the public Unity migration
rules for these version pairs:

| Unity Editor | URP Package | Mechanical rules |
|---|---|---|
| 2022.2 or 2022.3 | stable 14.x | Enabled for an official resolved Package. |
| 6000.0 | stable 17.x | Enabled for an official resolved Package. |
| Any other, unknown, forked, local, or cross-paired version | Any | Report-only; no automatic edit. |

For a complete single-SubShader, single-Pass, Pass-owned program with no
semantic blocker, the report can replace `CGPROGRAM`/`ENDCG`, the exact
`UnityCG.cginc` include, `UnityObjectToClipPos`, and `fixed` types, and can add
the `UniversalPipeline` SubShader tag. These are individual syntax fixes, not a
whole-shader converter. Surface pragmas, Built-in lighting, GrabPass,
texture/sampler migration, UnityCG-provided appdata or macros, custom includes,
conditional/generated macros, UsePass/Fallback ownership, another pipeline
tag, a Built-In `LightMode`, multiple SubShaders/Passes/programs, and malformed
layout suppress every portability Quick Fix. `UnityPerMaterial` work remains
human-owned unless the separate SRP Batcher diagnostic can prove its narrower
exact insertion.

Selecting a graphics profile asks the connected Unity Editor Adapter to compile
the exact saved source hash. The report distinguishes passed, failed,
profile-not-supported, and unavailable evidence; Adapter project, instance,
Unity version, capability, source URI, and content hash checks still apply. A
successful compile proves only that exact source/profile attempt, not rendered
equivalence or another profile. The current Adapter protocol binds provenance
to diagnostics, so an empty completed response carries no source revision to
verify and remains `invalid-evidence`; the report does not infer a clean compile
from an unbound empty array.

The checked-in `birp-urp-unlit` before/after fixture currently exercises the
safe-edit result and exact-hash Adapter protocol with a mock compiler boundary.
It is deliberately not described as a Unity Editor compile capture. Real Unity
compile verification of both fixture revisions remains pending until a
connected Adapter run is available.

The rules and limits follow Unity's public documentation for
[converting custom shaders to URP](https://docs.unity3d.com/Manual/urp/urp-shaders/birp-urp-custom-shader-upgrade-guide.html),
[URP SRP Batcher material layout](https://docs.unity3d.com/Manual/urp/shaders-in-universalrp-srp-batcher.html),
[URP version requirements](https://docs.unity3d.com/Manual/urp/requirements.html),
and [Surface Shader render-pipeline support](https://docs.unity3d.com/Manual/SL-SurfaceShaders.html).

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

- Click the `Variants: N/off` status-bar item (shown for `.shader`, `.hlsl`,
  `.cginc`, `.hlslinc`, and `.compute` files) to open a QuickPick listing
  every `multi_compile` / `shader_feature` keyword the document declares.
- Toggle keywords on/off. The chosen set is sent to the server as the active
  `VariantContext`.
- **Dimming**: branches gated by an active keyword brighten (no longer dimmed);
  branches gated by an inactive keyword dim as "inactive" (definitely off in
  this context). Branches gated by unknown macros stay visible (conservative).
- **F12 / Find References / Highlights**: every conservative candidate remains
  available. Candidates active in the selected context rank first; a context
  never removes valid navigation results.
- **Clear (conservative)**: removes the context and restores the default
  behaviour.

The selection is kept in memory for the editor session; it is not persisted
across restarts. No settings are required. The feature is purely opt-in —
opening the picker is never required, and the default behaviour is unchanged.

This is a user-driven presentation and candidate-ordering aid, not a
compiler-accurate variant resolver. It covers only the keywords the document
itself declares; platform defines and material/global keyword state are out of
scope. The selection does not enumerate the combinations shown by the separate
declared-cost presentation below.

### Shader Include-point Context

A shared `.hlsl`, `.cginc`, or `.hlslinc` file can be reached from several
Shader programs with different macro state. When the published index knows at
least one such route, the **Context: Auto** status-bar item opens a QuickPick of
known Shader, Pass, stage, entry-point, and include-location combinations.

Selecting one Context applies the deterministic `#define` / `#undef` state
accumulated along that concrete include chain to inactive-region dimming,
semantic coloring, completion ordering, and static diagnostics. Nested include
chains are supported. Definition, References, and Highlights deliberately keep
all conservative candidates; active candidates may rank first, and the status
bar keeps the selected Context visible.

The selection belongs to the client session and is never written to the index
or cache. It is tied to the exact published revision that supplied the list, so
a live edit, rebuild, deletion, or newly invisible include point switches the
selection back to **Auto** instead of combining facts from two revisions.
Choosing a Context does not rebuild the Workspace or unrelated roots.

### Compiler Evidence Views

After selecting a Shader include-point Context, use **UnityShaderNav: Open
Source Shader View**, **Open Preprocessed Shader View**, or **Open Generated
Shader View**. A connected Unity Editor Adapter must verify both that Context
and one compile profile; when several profiles are available, VS Code asks you
to choose one. Adapter absence, an unsupported profile, or invalid evidence is
reported as unavailable rather than replaced with static-analysis guesses.

Preprocessed and Generated views are read-only virtual documents. Their first
two lines show `CURRENT` or `STALE` plus the Context, profile, Unity version,
and Adapter version. Unity documents that retained `#line` directives can map
back to original code; Unity describes those directives as the link between
preprocessed and original ShaderLab/HLSL source in its
[Shader Import Settings reference](https://docs.unity3d.com/Manual/class-ShaderImporter.html).
UnityShaderNav additionally requires the directive name to resolve to exactly
one Adapter-supplied source identity, the source hash to match, and the complete
line text to be unchanged. This intentionally leaves macro expansions,
ambiguous/unknown sources, invalid line numbers, and generated-only code as
visible mapping gaps.

F12 in a mapped Preprocessed or Generated region opens the original source.
The **Go to Preprocessed Compiler Mapping** and **Go to Generated Compiler
Mapping** commands navigate from original ShaderLab/HLSL/include source in the
other direction; repeated include expansions remain multiple selectable
locations. Compiler diagnostics use a proven original source line when one is
available and add a clickable Generated evidence link. If Unity supplies no
trustworthy location, the diagnostic says so and is shown at the owning Shader
without pretending that its first line is the compiler location.

Any live edit, watched-file change, deletion, Adapter disconnect/reconnect, or
replacement evidence marks the old virtual documents stale immediately.
Stale text remains available for comparison, but all old mappings are disabled
until new hash-matching evidence arrives. Compiler evidence is session-only and
never enters the project index or persistent cache.

### Selected Material Context

When a connected Unity Editor Adapter reports a selected persistent Material,
the **Material: _name_** status-bar item opens a read-only evidence list. The
same list is available through **UnityShaderNav: Show Selected Material
Context** and includes:

- the Material asset and its Shader;
- selected SubShader and Pass identity when Unity can supply it;
- serialized Material Property values and texture bindings;
- enabled and disabled Material keywords, including whether the Adapter
  identified a LocalKeyword or only legacy keyword evidence; and
- the producing project, Editor instance, Unity version, Adapter version,
  selection identity, asset revisions, and published source revision.

The server accepts this overlay only when the Adapter handshake, feature
capability, project, Editor instance, Material GUID/path/content hash, Shader
GUID/path/content hash, and current published source all agree. A reconnect,
rapidly superseded selection response, deleted asset, live source edit, or
changed saved file clears the overlay instead of reusing stale facts.

Matching Property/keyword completion entries are annotated and ranked first;
Definition candidates in the selected Shader rank first. These are stable
partitions of the conservative results: Material Context never removes a
completion or navigation candidate and never enters the index or cache.

Material Context is **not the final draw Context**. A Material selection does
not prove which renderer, camera, platform, graphics API, dynamic pass, global
keyword, or engine-added keyword participates in a real draw. Global and
engine-added keyword state therefore remains visibly **unknown** until a later
source supplies actual draw evidence.

### Declared Variant Cost

VS Code shows a CodeLens above each supported `#pragma multi_compile` or
`#pragma shader_feature` keyword set. In a `.shader` source, only pragmas
inside `HLSLPROGRAM` / `CGPROGRAM` / `HLSLINCLUDE` / `CGINCLUDE` blocks are
counted; ShaderLab text outside those blocks stays neutral. The lens labels
the value as **Declared/static**, shows the normalized set multiplier,
global/local scope, all-stage or stage-specific suffix, and the containing
program's upper bound. Repeated options, conditional declarations, and
duplicate sets contributing `×1` are flagged on the lens where they apply.
An additional lens on each `HLSLPROGRAM` / `CGPROGRAM` marker shows that
program's upper bound, number of unique sets, and largest multiplier; a
program with no declared set gets no lens. In a raw HLSL or Compute document,
the file is the one document-local program and its summary lens sits on the
first line. Every lens is clickable and opens this explanation.

The estimate has one deterministic contract:

- Exact `multi_compile`, `shader_feature`, their `_local` forms, and the
  `_vertex`, `_fragment`, `_hull`, `_domain`, `_geometry`, and `_raytracing`
  suffixes are supported; `_local` can combine with one stage suffix (for
  example `shader_feature_local_fragment`). Built-in `multi_compile_*`
  shortcuts are not expanded.
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

### Variant Build Comparison

With a saved `.shader` asset open, run **UnityShaderNav: Show Variant Build
Comparison**. The report joins the current source-only estimate to evidence
from a connected Editor Adapter that advertises `variant-build-evidence`.
Every row is keyed by Shader, SubShader/Pass, Stage, Unity build target, and
graphics API, and the three numbers retain different labels and meanings:

- **Declared/static upper bound** is recalculated from the current source. It is
  still a theoretical product, even when a matching build is available.
- **Compile candidates/measured** is the Adapter's aggregate count before Unity
  Variant stripping.
- **Kept/measured** is the Adapter's aggregate count after stripping.
- **Unavailable** carries a reason such as no Adapter, unsupported capability,
  missing collection, failed build phase, or source drift. It is never shown as
  zero.

The report lists comparable keyword sets by `Declared/static set multiplier −
Kept/measured set count`, largest gap first. Keyword-set gaps are diagnostic
leads rather than a claim that independent sets explain every interaction in
Unity's stripping pipeline.

Build evidence includes the project identity, Adapter and Unity versions,
Unity build target, graphics API, asset GUID, saved-content hash, and collection
timestamp. If the open text no longer matches the collected hash, the whole
build snapshot is reported as source drift and no measurement is joined to the
new declaration. An Editor disconnect or reconnect likewise invalidates an
in-flight or prior-instance response.

The Adapter payload is aggregate and bounded: the language server accepts at
most 2,048 Context rows, 256 keyword sets per row, and 8,192 keyword sets in one
snapshot. It rejects an oversized snapshot rather than truncating it and
claiming completeness. A build with status `incomplete` or `failed` can retain
validated partial Compile candidates while Kept evidence stays explicitly
unavailable, together with the failed phase and message. None of this evidence
enters the Published indexed revision or changes conservative navigation.

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
