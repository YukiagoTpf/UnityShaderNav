# Troubleshooting

## F12 Only Works in the Current File

The extension is probably in standalone mode. Make sure the workspace or
`unityShaderNav.projectRoot` points at a directory containing both `Assets/` and
`ProjectSettings/`.

## Package Includes Do Not Resolve

Check that the Unity project has `Packages/packages-lock.json`. UnityShaderNav
uses that file to map `Packages/<name>/...` include paths to physical package
folders.

If the package path is unusual, file an issue with:

- Unity version.
- The package entry from `packages-lock.json`.
- The include path in the shader.
- The expected physical target path.

## A Macro-Declared Variable Does Not Navigate

If the variable is declared through a project-specific macro, add it to
`unityShaderNav.declarationMacros`.

Example:

```jsonc
{
  "unityShaderNav.declarationMacros": [
    { "pattern": "MY_TEX2D($name)", "kind": "variable" }
  ]
}
```

## Find References Shows Too Much or Too Little

By default, package references are excluded. Set
`unityShaderNav.findReferences.includePackages` to `true` if you need package
usage sites.

If unrelated project files still appear, open an issue with a minimal pair of
files that share the same symbol name.

## The Extension Still Uses Old Results

Rebuild and reload the Extension Development Host. If cache corruption is
suspected, delete:

```text
<UnityProject>/Library/UnityShaderNavCache/
```

The cache will be rebuilt automatically.

## Collecting Diagnostics

Open VS Code's Output panel and choose `UnityShaderNav`.

For definition issues, temporarily enable:

```jsonc
{
  "unityShaderNav.debug.definitionTrace": true
}
```

Attach the relevant output to the GitHub issue, then turn the setting off.
