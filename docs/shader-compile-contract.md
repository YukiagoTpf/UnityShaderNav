# Shader Compile Contract

`shader-compile-contract.json` is the repository-owned verification boundary for
selected Shader assets. It combines four evidence classes without treating one
as a substitute for another:

- exact-source Unity compiler messages for required platform profiles;
- required Adapter capabilities;
- locally provable SRP Batcher `UnityPerMaterial` contracts;
- the declared/kept Variant limits in `shader-budgets.json`.

Run the same command locally and in CI:

```bash
npm run check:shader-contract
```

The command prints a stable human report and writes the machine report to
`Library/UnityShaderNavReports/shader-compile-contract-report.json`. `Library/`
is Unity-generated and ignored by Git. To stream only JSON to stdout:

```bash
npm --silent run check:shader-contract -- --json -
```

## Contract

The version 1 contract selects explicit Shader scopes and profiles:

```json
{
  "schemaVersion": 1,
  "policy": { "unverified": "fail" },
  "requiredCapabilities": [
    "shader-messages",
    "variant-build-evidence"
  ],
  "scopes": [
    {
      "id": "forward-lit",
      "source": "Assets/Shaders/ForwardLit.shader",
      "srpBatcher": "required",
      "profiles": [
        {
          "profile": {
            "name": "macOS Metal",
            "platform": "StandaloneOSX",
            "graphicsApi": "Metal",
            "capability": "compile-profile/macos-metal"
          },
          "evidence": "ShaderEvidence/ForwardLit.metal.json",
          "warnings": {
            "forbiddenMessageSubstrings": [
              "implicit truncation"
            ],
            "baseline": []
          }
        }
      ]
    }
  ],
  "variantBudgets": "shader-budgets.json"
}
```

Profile identity is the exact tuple of name, platform, graphics API, and
capability. The evidence must advertise every repository-required capability,
the profile capability, and `shader-messages`. A missing capability is
`unverified`; it is not inferred from the host operating system.

`srpBatcher: "required"` fails on deterministic Property/type/layout
diagnostics. If includes, conditional declarations, multiple SubShaders, or
incomplete blocks prevent an exact local inventory, the SRP check is
`unverified`. Use `"ignore"` only when the selected scope intentionally has no
SRP Batcher contract.

## Captured compiler evidence

A completed evidence file is an offline envelope around one exact Adapter run:

```json
{
  "schemaVersion": 1,
  "status": "completed",
  "supportedFeatures": [
    "compile-profile/macos-metal",
    "shader-messages",
    "variant-build-evidence"
  ],
  "profile": {
    "name": "macOS Metal",
    "platform": "StandaloneOSX",
    "graphicsApi": "Metal",
    "capability": "compile-profile/macos-metal"
  },
  "durationMs": 42,
  "provenance": {
    "capability": "shader-messages",
    "adapterVersion": "0.1.0",
    "unityVersion": "2022.3.62f1",
    "projectId": "project-id",
    "instanceId": "editor-instance",
    "collectedAt": 1000,
    "sourceRevision": {
      "uri": "project://Assets/Shaders/ForwardLit.shader",
      "assetGuid": "asset-guid",
      "contentHash": "SHA-256"
    }
  },
  "diagnostics": []
}
```

The source SHA-256 and profile must match the current contract scope. Compiler
errors always fail. A warning fails when it is new relative to `baseline` or
contains a forbidden message substring. Resolved baseline warnings are retained
in the machine report for review.

An Adapter, Unity installation, license, or platform may be unavailable. Record
that fact explicitly when exporting evidence:

```json
{
  "schemaVersion": 1,
  "status": "unavailable",
  "reason": "unity-license-unavailable"
}
```

A missing file, stale source hash, unsupported profile, partial capability set,
or unavailable envelope produces `unverified`, never a zero-warning pass.

## Status and CI policy

The machine report keeps `pass`, `failed`, and `unverified` distinct. Failed
checks dominate the aggregate status. Exit codes are stable:

- `0`: all checks pass, or only unverified checks remain and the contract
  explicitly uses `"unverified": "allow"`;
- `1`: compiler errors, new/forbidden warnings, deterministic SRP failures, or
  Variant budget regressions;
- `2`: evidence is unverified while project policy is `"fail"`, or a requested
  baseline cannot be produced from verified evidence;
- `3`: invalid arguments, invalid contracts, or an unexpected verifier error.

This repository uses `"unverified": "fail"`. CI therefore cannot silently pass
because Unity, a license, an Adapter capability, or required build evidence is
absent.

## Baseline review

After intentionally accepting current compiler warnings and Variant
measurements, update both baselines with:

```bash
npm run check:shader-contract -- --write-baseline
```

The command refuses to write a warning or Variant baseline when its required
evidence is unverified. Review the resulting contract and budget diffs before
committing them. Forbidden warning patterns and absolute maxima remain active;
baseline updates do not approve compiler errors or bypass those policies.

The committed scope and evidence under `server/tests/contracts/fixtures/` are a
cross-platform protocol self-check for this repository. Product repositories
should replace or extend that scope with their own Adapter-captured Shader
assets and required platform profiles.
