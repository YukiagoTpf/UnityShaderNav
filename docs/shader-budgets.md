# Shader Variant Budgets

UnityShaderNav includes a repository-owned verification command for Shader
Variant budgets:

```powershell
npm run check:shader-budgets
```

The command reads `shader-budgets.json` from the repository root, prints a
stable human-readable result, writes the machine-readable report to
`Library/UnityShaderNavReports/shader-budget-report.json`, and exits non-zero
for both `failed` and `unverified` results. `Library/` is Unity-generated and
normally ignored by source control.

CI runs this exact root command on Linux, Windows, and macOS.

## Contract

The contract uses `schemaVersion: 1` and must contain at least one budget:

```json
{
  "schemaVersion": 1,
  "budgets": [
    {
      "id": "lit-forward-windows",
      "source": "Assets/Shaders/Lit.shader",
      "selector": {
        "shaderName": "Project/Lit",
        "subShaderIndex": 0,
        "passName": "Forward",
        "stage": "fragment",
        "buildTarget": "StandaloneWindows64",
        "graphicsApi": "Direct3D11"
      },
      "evidence": "Library/ShaderEvidence/Lit-Windows.json",
      "limits": {
        "declaredMax": "800",
        "keptMax": "240",
        "declaredMaxDelta": "40",
        "keptMaxDelta": "20"
      },
      "policy": {
        "contextChanges": "fail",
        "keywordSetChanges": "fail"
      }
    }
  ]
}
```

All paths are relative to the contract. Counts are decimal strings so Variant
products remain exact beyond JavaScript's safe integer range.

Selectors can scope a budget at three levels:

- Per Shader: only `shaderName` is required.
- Per Pass or stage: add `subShaderIndex`, `passIndex`, `passName`, or `stage`.
- Per platform: add `buildTarget` and/or `graphicsApi`.

Matching Context counts are summed. Declared/static counts come directly from
the current Shader source and do not claim platform-specific compiler
behavior. Kept counts require completed, structurally valid Unity build
evidence whose source SHA-256 still matches the current Shader. A missing,
failed, incomplete, stale, or malformed evidence file is `unverified`, never
zero.

`declaredMax` and `keptMax` cap the current count.
`declaredMaxDelta` and `keptMaxDelta` cap growth relative to a baseline. The
strict default policy also fails when source Contexts or keyword-set identities
are added, removed, or changed. Set the corresponding policy to `allow` only
when count thresholds alone intentionally own that dimension.

## Create or Refresh Baselines

Run:

```powershell
npm run check:shader-budgets -- --write-baseline
```

The command replaces every baseline with current verified counts, Context
inventory, and keyword-set inventory. It refuses to write a partial baseline
when a required measurement is unverified. Review and commit the resulting
contract like any other budget change.

Baseline snapshots make failures actionable. A jump such as 800 to 40000
reports the Shader/Pass/stage Context and the keyword sets that were added,
removed, or changed, alongside exact before/after counts.

## Options and Exit Codes

```powershell
npm run check:shader-budgets -- --config path/to/budgets.json
npm run check:shader-budgets -- --json path/to/report.json
npm --silent run check:shader-budgets -- --json -
```

- Exit `0`: every budget passed.
- Exit `1`: at least one budget failed or is unverified.
- Exit `2`: command arguments or the contract are invalid, or verification
  crashed.

With `--json -`, JSON goes to standard output and the human report goes to
standard error. Reports contain no generation timestamp or absolute local
path, so identical inputs produce byte-stable CI output.
