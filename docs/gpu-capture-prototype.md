# GPU Capture-to-source Prototype

The issue #102 prototype exercises one deliberately narrow path:

- macOS on Apple silicon;
- Unity 2022.3.62f1 using Metal;
- Xcode Metal Frame Debugger and a local `.gputrace`;
- one repository-owned command-buffer draw;
- one exact fragment entry-point source range.

It is a source-correlation experiment, not production capture UI or a generic
GPU debugger integration. See
[ADR-0012](adr/0012-macos-metal-capture-source-correlation-prototype.md) for
the tool decision, evidence boundary, observed mapping failures, and criteria
for a second Adapter.

## Verify the bounded fixture

The sanitized fixture contains no raw trace or captured resources:

```bash
npm run check:gpu-capture-prototype
```

The command validates the versioned evidence envelope, asset GUID, exact
Shader SHA-256, project/profile identities, Shader Context, and mapped `frag`
token. Because no raw trace is checked in, this path is explicitly reported as
`sanitized-fixture`. Its machine report is written to
`Library/UnityShaderNavReports/gpu-capture-correlation-report.json`.

`STALE` means the source URI or hash changed. `UNAVAILABLE` means the evidence,
project, or replay environment is incompatible. `UNMAPPED` preserves a
tool/source-map failure. Only `CURRENT` returns a source location.

## Run a real local capture

First verify the host:

```bash
UNITY_PATH=/path/to/Unity npm run gpu-capture:preflight
```

Then run the isolated project:

```bash
UNITY_PATH=/path/to/Unity npm run gpu-capture:capture
```

The runner requires macOS/arm64, Xcode, `xcrun metal`, and Unity
2022.3.62f1. The isolated project has no package dependencies, so the runner
uses `-noUpm` to keep Package Manager startup outside the experiment. It sets
`MTL_CAPTURE_ENABLED=1`, launches Unity with `-enable-metal-capture`, executes
one named `CommandBuffer.DrawMesh`, exits batch mode, and passes the resulting
evidence through the TypeScript correlation Adapter. The Adapter independently
recomputes the `.gputrace` tree hash and byte length and verifies that the raw
trace contains the named command-buffer label. That label includes the
pre-capture Shader hash prefix and Context ID. The emitter forces a synchronous
import and rejects source drift before or after capture. The runner deletes
prior outputs and binds new evidence to a fresh invocation ID. A missing,
modified, stale, or internally inconsistent trace/evidence pair cannot be
`CURRENT`. This bounded byte-level check is an integrity check, not
cryptographic attestation that an arbitrary file was created by Xcode.

Outputs stay under:

```text
tools/gpu-capture-prototype/UnityProject/Library/UnityShaderNavGpuCapture/
```

- `CaptureProbe.gputrace` — raw local Xcode trace;
- `CaptureProbe.evidence.json` — bounded local evidence.

Both are derived data. Raw GPU traces can contain textures, buffers, and other
captured resources; they must not be committed or shared without a separate
content review. The repository ignores `.gputrace`, Unity `Library/`, and
`UserSettings/`.

The checked-in JSON fixture under
`server/tests/adapter/fixtures/gpu-capture/` is sanitized and bounded. It
retains the contract shape and source identity required for deterministic
tests, not raw GPU contents.

## Evidence and failure semantics

The Adapter requires:

- capture/frame/draw identity and a local trace hash/size;
- macOS, architecture, GPU, OS-coupled driver, Metal, Xcode, Unity, Adapter,
  project, instance, and timestamp provenance;
- current Shader asset GUID/URI/SHA-256;
- SubShader, Pass, stage, entry point, and bounded keyword facts. The explicit
  `CAPTURE_TINT` keyword is known, but the engine/global set is not proven
  complete and is marked accordingly;
- an exact source range whose current text equals the captured entry point.

Changing the Shader source or recreating its Unity asset GUID makes the
evidence `STALE` before range navigation.
Any macOS build, GPU/driver, Metal toolchain, Xcode build, Unity, or Adapter
identity drift is `UNAVAILABLE`; the first prototype does not assume
cross-environment replay compatibility. If Xcode or Unity-generated shader
evidence lacks an exact original-source line map, the result is `UNMAPPED`;
the Adapter never guesses from generated function text.

The current experiment records one exact controlled draw. It does not claim
that arbitrary Xcode traces can be mapped without Adapter-owned source
identity.
