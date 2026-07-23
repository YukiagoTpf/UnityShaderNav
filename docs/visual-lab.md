# Unity-rendered Visual Lab

Visual Lab is a bounded, session-only comparison surface for one explicitly
pinned Material and Shader Context. It asks the connected Unity Editor to render
each frame; it does not implement a parallel preview renderer in the extension.

This is not a general Unity Scene preview. The first version renders one
repository-defined offscreen input and exposes one independent NaN/Inf
diagnostic.

## Install and connect the Unity Editor Adapter

Visual Lab and other Adapter-backed features require the Editor-only UPM package
in `unity-adapter/`. The package requires Unity 2022.3 or newer.

From a repository checkout:

1. Open the target project in Unity.
2. Open **Window > Package Manager**.
3. Select **+ > Add package from disk...**.
4. Select `unity-adapter/package.json` from the checkout.

Installation is always a user action. The VS Code extension never edits
`Packages/manifest.json` or installs Editor code silently.

The package starts with the Editor and writes the derived descriptor
`Library/UnityShaderNavAdapter/session.json`. The extension verifies the
descriptor's project hash and protocol version, then authenticates one local
stream with the per-run token:

- Windows uses a current-user named pipe.
- macOS and Linux use a user-permissioned Unix domain socket.
- No TCP listener or remote transport is used.

One Unity project has one authenticated Adapter stream. Several VS Code
Workspace folders that resolve to the same Unity project share it; folders
owned by different Unity projects have isolated clients, registries, tokens,
and evidence. A domain reload or Editor restart creates a new instance and
token. Reconnection is automatic, but prior evidence remains stale and must not
cross into the new instance.

The Editor and extension must run as the same OS user on the same machine.
Remote Editor/extension splits, containers, SSH, and cross-OS WSL topologies are
not supported by this local transport.

## Pin a target

Visual Lab deliberately combines two existing explicit choices:

1. In Unity, select one saved, persistent Material asset.
2. In VS Code, open a Shader include source reached by that Material's Shader
   and select one exact **Context: ...** entry from the published Shader
   include-point Context picker.
3. Run **UnityShaderNav: Open Visual Lab**.
4. Press **Use Current Selected Material**.

The final action pins the selected Material, its saved Shader revision, and the
selected Context from that exact Published indexed revision. Merely opening the
panel does not query a new selection, and changing the Unity selection never
silently retargets an existing panel.

The target remains unavailable when the Adapter cannot prove an exact
persistent Material/Shader asset, a unique pass, and an explicit supported
stage entry point. Version 1 refuses a non-zero SubShader-to-pass mapping rather
than guessing through Unity's flattened public pass API.

## Capture Before and After

Press **Capture Before** and **Capture After / Refresh** separately. Each button
issues one independent authenticated request and one real Unity draw. Visual Lab
never renders on a timer, in response to saving, or in the background.

The controlled v1 input is:

- a hidden 64x64 `ARGBFloat` offscreen render target;
- the pinned Material and pass through Unity's `Material.SetPass`;
- one full-screen triangle with fixed identity matrices;
- no open Scene, Scene camera, Scene geometry, or Scene lighting dependency;
- point sampling, no MSAA, and a linear render target; and
- a versioned render-input identity
  `unity-shader-nav/fullscreen-triangle/v1`.

The display PNG is a bounded view of the capture. Visual Lab also records the
PNG byte length and SHA-256 and validates them before embedding a `data:` image
in the Webview.

## Complete frame provenance

Before and After retain separate evidence. Each frame displays:

- capture time, request generation, selection identity, and Published Context
  revision;
- Material and Shader names, project-relative paths, URIs, asset GUIDs, and
  content hashes;
- Shader, SubShader, Pass, stage, entry point, and separate Material, global,
  and engine-added keyword collections; the v1 controlled draw reports the
  engine-added collection as empty;
- render-pipeline kind, name, identity, and persistent asset revision when it
  is an SRP asset;
- graphics profile, build target, graphics API, quality level, render-target
  dimensions and format, and project color space;
- Unity version, Adapter version, project identity, Editor instance, and
  render-input identity; and
- preview PNG byte length and SHA-256.

When both slots exist, the panel compares the target identities. It does not
turn pixel similarity into a correctness result.

## Staleness and failure behavior

Any selection, Material, Material revision, source revision, Shader Context,
pipeline, graphics profile, color-space, Adapter-instance, or render-input
change immediately invalidates the pin. In-flight requests are cancelled. Old
frames remain visible only with an explicit `STALE` badge, reason, and their
original provenance.

The same rule covers rapid edits, Editor disconnect, domain reload, and a late
response from a superseded request. Capture remains disabled until **Use Current
Selected Material** explicitly pins the new identity. A failed capture can
retain the previous frame, but failure never promotes it to current.

## Exact NaN/Inf mask

Unity reads the raw float target before it makes the display PNG. The diagnostic
is a separate top-left, row-major R8 payload with one byte per pixel:

- `255` when any raw channel is NaN or infinite;
- `0` otherwise.

NaN takes precedence when a pixel contains both classes. The server and Webview
require exactly 4,096 bytes for the 64x64 v1 target, permit only `0` and `255`,
and verify that NaN plus infinite counts equal both the declared and observed
masked-pixel count. Non-finite display values are sanitized only after this mask
has been collected.

This diagnostic is not derived from the PNG and is not verified by an image
diff.

## Session and privacy boundary

Visual Lab targets, frames, masks, and Webview state are held only for the
current extension/language-server session. They are not written to the source
index, `Library/UnityShaderNavCache/`, VS Code workspace/global storage, project
assets, or telemetry.

Visual Lab does not automatically repair Shaders, modify Materials, render an
arbitrary Scene or Renderer, run continuously, measure overdraw, or provide
additional diagnostic views.

## Contributor verification

The offline structural check validates the real-runner contract, repository
UPM wiring, controlled Shader input, and independent mask protocol without
launching Unity. It is also part of `npm run check:fast`:

```bash
npm run check:visual-lab-prototype
```

Run the real end-to-end proof explicitly with a Unity executable:

```bash
npm run visual-lab:prototype -- --unity <Unity-executable>
```

The command builds the current sources, launches the repository's isolated
Unity project in batch mode, discovers and authenticates its UPM Adapter, pins
the controlled persistent Material, and sends independent Before and After
requests. It validates two real 64x64 Unity frames, their PNG hashes, and an
exact mask containing 64 NaN pixels plus 64 infinite pixels. It never opens a
product Unity project and stops only the Unity process that it launched.

See
[ADR-0013](adr/0013-explicitly-pinned-unity-rendered-visual-lab.md) for the
ownership, identity, staleness, and scope decision, and
[ADR-0008](adr/0008-unity-editor-adapter-lifecycle-and-trust-model.md) for the
local Adapter trust model.
