# Explicitly Pinned Unity-rendered Visual Lab

## Status

Implemented — 2026-07-24 by
[#103](https://github.com/YukiagoTpf/UnityShaderNav/issues/103).

## Context

Static source analysis, compiler evidence, and Material Context answer different
questions. None of them proves what Unity produced for one draw. A useful visual
experiment therefore needs real Unity rendering, but a general Scene preview
would immediately inherit uncontrolled camera, lighting, renderer, pipeline,
keyword, and asset state. Automatically following the Unity selection would
also make a retained image look current after its target had changed.

The first slice needs a comparison surface that remains useful across source
edits while refusing to mix identities. It also needs one diagnostic whose
correctness can be asserted independently from image-diff tolerance.

[ADR-0008](0008-unity-editor-adapter-lifecycle-and-trust-model.md) already
defines the local, authenticated Unity Editor Adapter stream. Visual Lab must
reuse that boundary and Unity's renderer rather than introduce another render
pipeline or network service.

## Decision

### Explicitly owned surface and target

Expose one persistent VS Code Webview through **UnityShaderNav: Open Visual
Lab**. Opening the panel does not render or select anything. The user must press
**Use Current Selected Material** to pin both:

- the persistent Material currently selected through Adapter-backed Material
  Context; and
- the explicitly selected Shader include-point Context from one Published
  indexed revision.

The Adapter resolves that pair to one complete controlled draw identity. State
reads never consult Unity for a replacement selection, and later Unity
selection changes never silently retarget the panel.

### Two explicit, independent captures

**Capture Before** and **Capture After / Refresh** each issue one separate
`visual-lab-render/v1` request. There is no timer, file-save render, selection
render, or background refresh.

The v1 Adapter renders the requested persistent Material pass through Unity into
a repository-owned, offscreen 64x64 `ARGBFloat` target. The input is a
deterministic full-screen triangle with fixed matrices, no product Scene, no
Scene camera or lighting dependency, point sampling, and a linear render
target. The Adapter revalidates the Material, Shader, pass, entry point,
keywords, pipeline, graphics profile, project color space, Adapter instance,
and render-input identity immediately before every draw.

Before and After are separate evidence envelopes. Each carries its own request
generation, capture time, PNG bytes and SHA-256, and complete target provenance:
selection and publication identities; Material and Shader paths, GUIDs, URIs,
and content hashes; Shader/SubShader/Pass/stage/entry point and final keyword
sets; render-pipeline identity; build target, graphics API, quality level and
render-target profile; color space; Unity/Adapter/project/instance identities;
and controlled render-input identity.

### Stale means unusable as current evidence

Selection, Material, Material revision, source revision, Shader Context,
pipeline, graphics profile, color space, Adapter instance, or render-input
changes immediately cancel in-flight work. Any prior frame remains visible only
as `STALE`, with the reason and its original provenance. Disconnect and domain
reload follow the same rule.

After invalidation, capture is disabled until the user explicitly pins the
current Material and Context again. An old response cannot become current:
request generation and the complete render-target identity must still match
when the response arrives.

### Independent NaN/Inf diagnostic

The Adapter reads the float render target before producing the display PNG. It
returns a separate top-left, row-major R8 mask with exactly one byte per pixel:
`255` when any raw channel is NaN or infinite, otherwise `0`. A pixel containing
both classes counts as NaN, so NaN has deterministic precedence and the two
class counts sum to the masked-pixel count.

The server and Webview validate dimensions, canonical base64, binary mask
values, byte length, and counts. Diagnostic correctness is proved from those
exact bytes; PNG or Before/After image-diff tolerance is not evidence for the
mask. Non-finite display channels are sanitized only when making the PNG, after
the mask has been collected.

### Session and trust boundary

Targets, frames, masks, and Webview state are session-only. They do not enter
the Published indexed revision, cache, workspace/global storage, source files,
or telemetry. The Webview accepts only validated `data:` PNGs and a validated
R8 payload under a restrictive content-security policy.

Visual Lab uses the one authenticated Adapter stream for its Unity project.
Workspace folders that resolve to the same Unity project share that stream;
different Unity project roots keep separate clients, registries, tokens, and
evidence lifecycles.

## Non-goals

- Rendering an arbitrary open Scene, Renderer, camera, or product-project
  preview.
- Continuous, save-triggered, selection-triggered, or background rendering.
- Automatic Shader repair or applying edits from an image.
- Overdraw, performance profiling, image-diff pass/fail thresholds, or
  additional diagnostic modes.
- Persisting captures or sending render evidence through telemetry.

## Consequences

- Visual comparison is slower and more deliberate than an automatically
  refreshed preview, but every current frame has one inspectable identity.
- A retained stale frame remains useful for human comparison without being
  presented as current evidence.
- Real validation requires a compatible Unity Editor and `ARGBFloat` support;
  protocol and lifecycle tests remain available without launching Unity.
- Expanding to another input, diagnostic, or Scene workflow requires a new
  versioned identity and a separately reviewed decision.
