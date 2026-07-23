# macOS Metal Capture-to-source Correlation Prototype

## Status

Accepted — 2026-07-24 by
[#102](https://github.com/YukiagoTpf/UnityShaderNav/issues/102).

## Context

GPU capture tools own large, hardware- and tool-version-specific trace
formats. Defining a generic multi-tool interface before proving one end-to-end
source correlation would turn unknown RenderDoc, Xcode, D3D, Vulkan, and device
semantics into an unstable common denominator.

The smallest credible experiment available to this repository is macOS on
Apple silicon, Unity 2022.3 LTS using Metal, and Xcode Metal Frame Debugger:

- Unity exposes `UnityEngine.Apple.FrameCapture` and can write a
  `.gputrace` without injecting a native plugin;
- the controlled host has the Unity, Xcode, and Metal toolchain needed to run
  a real capture;
- one graphics API and one first-party capture tool isolate source identity
  and staleness risk from multi-tool dispatch;
- Apple's GPU driver is OS-coupled, so GPU name, Metal device string, and the
  exact macOS build together form the bounded driver identity.

Unity documents
[`FrameCapture`](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Apple.FrameCapture.html)
as its Xcode capture interface and exposes explicit file capture boundaries.
Apple documents `.gputrace` as the replayable file destination for
programmatic Metal capture in
[Capturing a Metal workload programmatically](https://developer.apple.com/documentation/xcode/capturing-a-metal-workload-programmatically).

## Decision

### One isolated capture

Keep a repository-owned minimal Unity project under
`tools/gpu-capture-prototype/UnityProject`. Its capture method:

1. requires macOS/arm64, Metal, Unity 2022.3.62f1, Xcode, and the Metal
   toolchain at preflight;
2. disables Package Manager startup because the isolated project has no
   package dependencies, then creates one named command buffer with one
   deterministic `DrawMesh`;
3. brackets that command with `FrameCapture.BeginCaptureToFile` and
   `FrameCapture.EndCapture`;
4. writes the raw `.gputrace` only below the project's ignored `Library/`;
5. emits a bounded JSON evidence envelope; the TypeScript Adapter independently
   re-hashes the trace tree, checks its byte length and filename, and finds the
   named command-buffer label before accepting the real capture.

Before import and capture, the emitter reads the exact Shader bytes, computes
their SHA-256 and source range, forces a synchronous import, and verifies that
the bytes are unchanged. It verifies the same bytes again after capture. The
command-buffer label includes the source-hash prefix and Shader Context ID, so
the independently observed trace label binds the workload to that preselected
revision and Context rather than to a reusable constant.

The command is explicit and opt-in:

```bash
UNITY_PATH=/path/to/Unity npm run gpu-capture:capture
```

It never opens, imports, or modifies a product Unity project.

### Versioned evidence seam

Capability `gpu-capture-correlation/v1` carries:

- capture ID, frame/draw index, label, local trace filename, trace tree hash,
  and byte length;
- macOS version/build, arm64, GPU name, OS-coupled driver string, Metal,
  Xcode version/build, Unity public version and exact selected binary identity,
  Adapter version, project/invocation identity, and collection timestamp;
- exact Shader asset GUID, URI, SHA-256, SubShader/Pass, stage, entry point,
  and bounded keyword facts. The controlled `CAPTURE_TINT` keyword is known,
  while the complete engine/global keyword set is not, so `incomplete` remains
  true;
- either one exact source range plus expected token, or one explicit mapping
  failure.

The Adapter accepts only the selected project; the exact captured macOS
version/build, GPU/driver, Metal compiler, Xcode version/build, Unity version,
and Adapter version; exact asset GUID/source URI/hash; an in-bounds range; and
the expected entry-point text at that range. Version 1 has no evidence that a
broader replay matrix is safe, so later compatibility may be relaxed only
after explicit cross-environment captures. Real local
captures additionally require an independently verified trace hash, byte
length, filename, and command-buffer label. Asset recreation or source
URI/hash drift returns `stale` and no current location. Tool, trace, or
replay-environment mismatch returns `unavailable`. Missing source correlation
stays `unmapped`.

The sanitized checked-in evidence is a protocol fixture, not a raw trace and
is labeled `sanitized-fixture`; it is not a claim that its absent trace was
verified or that an arbitrary `.gputrace` contains original Unity HLSL.

### Mapping boundary and observed failures

The controlled Adapter pre-binds the only submitted `DrawMesh` to the exact
source revision before capture. The independently hashed Metal trace
corroborates the named command-buffer workload and preserves compiled
Metal/AIR evidence, but the trace does not
provide a stable, exact original Unity HLSL line map. Generated shader text,
function renaming, or a coincidental token match therefore cannot create a
source location.

Version 1 records these non-current outcomes explicitly:

- generated source has no line map;
- entry point is absent;
- more than one source range is possible;
- the capture tool omitted shader text;
- the trace version is unsupported;
- the mapped range or expected text no longer matches.

Raw traces can contain captured resources and can exceed repository-friendly
sizes. `*.gputrace`, Unity `Library/`, logs, and user settings remain local
derived data.

### Entry criteria for a second Adapter

Do not add multi-tool dispatch merely because another tool can create a
capture. A second Adapter requires all of:

1. a distinct, reviewed platform/use case that the Metal prototype cannot
   serve;
2. one real captured draw with stable tool-owned draw/pipeline identity;
3. a bounded export that proves Shader/Pass/entry/source identity without
   reverse-engineering or guessing;
4. source-drift and replay-version behavior equivalent to this Adapter;
5. sanitized fixtures and deterministic tests for mapping failures;
6. a demonstrated user workflow that justifies the added tool/version support
   cost.

Windows plus RenderDoc/D3D validation is separate work and does not weaken
these criteria.

## Consequences

- The repository now has one exercised GPU capture seam rather than a generic
  but unproven abstraction.
- A capture can enrich source navigation only while its project, source, tool,
  and replay identities are current.
- No raw GPU resource capture becomes public repository data.
- Adding another tool is an evidence and lifecycle decision, not a parser
  switch.
- Production capture UX, automatic trace browsing, iOS/device capture, and
  multi-tool routing remain out of scope.
