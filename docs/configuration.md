# Configuration

UnityShaderNav settings use the `unityShaderNav` prefix.

Server behavior settings are validated independently at each leaf. Invalid
values fall back to the documented default, while valid siblings in the same
nested object remain active. Those settings are resource-scoped; settings that
affect indexing trigger a workspace rebuild automatically. The standard
protocol trace setting is window-scoped because it controls one language-client
connection rather than one indexed resource. Every setting applies without
restarting VS Code.

## `unityShaderNav.projectRoot`

Type: `string`

Default: `""`

Explicit path to a Unity project root containing `Assets/` and
`ProjectSettings/`. Leave empty to autodetect from the active VS Code workspace.

```jsonc
{
  "unityShaderNav.projectRoot": "F:/Project/MyUnityProject"
}
```

## `unityShaderNav.includeDirectories`

Type: `string[]`

Default: `[]`

Extra include search directories. Use this for custom Unity editor installs,
shared shader libraries, or unusual built-in include locations.

```jsonc
{
  "unityShaderNav.includeDirectories": [
    "F:/Shared/Shaders",
    "D:/Unity/Editor/Data/CGIncludes"
  ]
}
```

## `unityShaderNav.excludePatterns`

Type: `string[]`

Default: `["**/Library/**","**/Temp/**","**/Logs/**"]`

Glob patterns skipped during user-file indexing. These patterns do not control
Unity Package indexing; packages are resolved from `Packages/packages-lock.json`.

## `unityShaderNav.declarationMacros`

Type: `object[]`

Default: `[]`

Additional macro patterns that declare variables or cbuffers.

```jsonc
{
  "unityShaderNav.declarationMacros": [
    { "pattern": "MY_TEX2D($name)", "kind": "variable" },
    { "pattern": "MY_CBUFFER($name)", "kind": "cbuffer" }
  ]
}
```

Supported `kind` values:

- `variable`
- `cbuffer`

## `unityShaderNav.findReferences.includePackages`

Type: `boolean`

Default: `false`

When `true`, Find References can include references from resolved Unity package
files. Keep this disabled when you only want project-authored usage sites.

## `unityShaderNav.debug.definitionTrace`

Type: `boolean`

Default: `false`

Logs detailed definition-resolution diagnostics to the `UnityShaderNav` output
channel. Enable this only while debugging a navigation problem.

## `unityShaderNav.dimInactiveBranches.enabled`

Type: `boolean`

Default: `true`

Dim inactive and variant-dependent preprocessor branches in shader/HLSL files.
This is a presentation-only editor aid: it visually dims `#if`/`#ifdef`/`#ifndef`
branches that are definitely inactive (file-local `#define`/`#undef` state) or
gated behind a Unity variant keyword from a `multi_compile*`/`shader_feature*`
pragma. Definitely inactive branches use plain fading; variant-dependent
branches use the same fading plus a theme-adaptive background marker. It never
affects Go to Definition, Find References, or completion. Set to `false` to turn
dimming off.

## `unityShaderNav.dimInactiveBranches.opacity`

Type: `number`

Default: `0.55`

Range: `0.1`–`1`

Opacity applied to dimmed preprocessor branches. Lower values fade the dimmed
branches more strongly; `1` leaves their text at full opacity while retaining
the theme-adaptive marker on variant-dependent branches.

```jsonc
{
  "unityShaderNav.dimInactiveBranches.enabled": true,
  "unityShaderNav.dimInactiveBranches.opacity": 0.55
}
```

## `unityShaderNav.trace.server`

Type: `string`

Default: `"off"`

Values: `"off"`, `"messages"`, `"verbose"`

Controls the standard language-server protocol trace written to the shared
`UnityShaderNav` output channel. `messages` records request and notification
flow; `verbose` also records payloads and can produce substantially more output.
This setting is window-scoped and applies without restarting VS Code.
