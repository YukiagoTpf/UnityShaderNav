# Contributing to UnityShaderNav

Thanks for taking a look at UnityShaderNav. The most useful contributions are
small, reproducible, and grounded in real Unity shader files.

## Before You Start

- Search existing [issues](https://github.com/YukiagoTpf/UnityShaderNav/issues).
- For behavior changes, open or comment on an issue with the shader shape, actual
  behavior, expected behavior, and minimal acceptance criteria.
- Keep pull requests focused. A regression test plus a narrow fix is ideal.

## Development Setup

```powershell
cd unity-shader-nav
npm install
npm run build
```

Open `unity-shader-nav/` in VS Code and press F5 to launch an Extension
Development Host. Open a real Unity project in that host to test package and
include resolution.

## Test Commands

Run from `unity-shader-nav/`:

```powershell
npm run build
npm run test -w @unity-shader-nav/server
npm test
node tests/out/runTest.js
```

Use focused server tests while developing, then run broader verification before
submitting a pull request.

## Pull Request Expectations

- Include regression coverage for parser, resolver, handler, or integration
  behavior when possible.
- Update user-facing docs for new settings, changed limits, or visible behavior.
- Keep commit messages conventional, for example `fix(issue-10): support git
  package paths`.
- Do not use `--no-verify`, force-push over reviewed work, or rewrite published
  history without maintainer agreement.

## Reporting Bugs

Good bug reports include:

- Unity version and render pipeline when relevant.
- File extension and a small shader snippet.
- Where the cursor was placed.
- Actual result and expected result.
- Whether the issue reproduces after rebuilding/reloading the Extension
  Development Host.

## Security

Please report security issues privately. See [SECURITY.md](SECURITY.md).
