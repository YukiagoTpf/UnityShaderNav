# Use the Git Repository Root as the Canonical Project Root

## Status

Accepted — 2026-07-10; implemented by
[#64](https://github.com/YukiagoTpf/UnityShaderNav/issues/64)

## Context

The repository currently has two competing roots:

- the Git root owns public documentation, contributor instructions, security
  policy, architecture decisions, and GitHub automation; and
- `unity-shader-nav/` owns the npm workspace, source, tests, build scripts,
  package lock, and VS Code launch configuration.

Of 338 tracked paths at the time of this decision, 298 (88%) are below the
nested source directory. The extra level does not isolate a second product,
release train, toolchain, or independently versioned package. It is therefore
not a domain boundary; it is an accidental path boundary across one product.

The split is visible in at least ten tracked public or automation entrypoints:
contributors must `cd unity-shader-nav`, VS Code must open that subdirectory for
F5 debugging, CI overrides its working directory and cache paths, extension
metadata points at `unity-shader-nav/client`, and packaging probes the parent
directory to recover the repository README and license.

## Options considered

### Retain the nested source root

This has no migration cost and keeps source visually separate from public
documents. The canonical command would remain:

```sh
cd unity-shader-nav
npm run <command>
```

The ongoing cost is paid by every contributor and automation path:

- opening the Git root does not discover the checked-in `.vscode` launch
  configuration or the npm TypeScript workspace;
- opening the nested directory hides the repository's documentation and agent
  context from the natural project tree;
- CI and external tools need working-directory and cache-path exceptions;
- package metadata and release scripts must understand both roots; and
- new scripts and documents must repeatedly decide which root “repository” or
  “project” means.

A wrapper `package.json` at the Git root was rejected. It would preserve both
roots and create a second command Interface rather than removing the ambiguity.

### Flatten the source root

This moves the npm workspace contents to the Git root. The one-time cost is
large in path count but shallow in semantics: 298 tracked paths move, while the
relative layout among `client/`, `server/`, `shared/`, `scripts/`, and `tests/`
does not change. npm workspace references, TypeScript project references, and
most build-script path resolution therefore remain unchanged.

The semantic edits are bounded to repository-facing paths:

- remove CI's nested working directory and update lockfile/test-runtime caches;
- move `.vscode` to the root so the normal checkout is directly debuggable;
- change extension repository metadata from `unity-shader-nav/client` to
  `client`;
- make package staging consume the root README and license directly;
- merge the redundant nested `.gitignore` rules into the root policy; and
- update public and agent-facing commands to run from the checkout root.

Git records the operation as renames, so file history remains available. The
published extension id, VSIX internal layout, package names, protocol, runtime
behavior, and cache location do not depend on the former directory name.

## Decision

Flatten the nested source directory. The Git repository root becomes the only
canonical project root for humans, agents, local tools, and CI.

After migration the root contract is:

```text
<repository>/
  package.json
  package-lock.json
  client/
  server/
  shared/
  scripts/
  tests/
  .vscode/
  docs/
```

All documented local and automation commands start at the Git root:

```sh
npm ci
npm run check:fast
npm test
npm run package:vsix
```

Build and test scripts resolve paths from their own checked-in location where
practical, so their behavior is not accidentally coupled to an arbitrary shell
working directory. npm remains the single command Interface; there is no
wrapper package, compatibility symlink, or retained nested shim.

VS Code contributors open the Git root and use the root `.vscode` launch
configuration. CI installs from the root lockfile and runs the same npm commands
without a default working-directory override. VSIX packaging still packages
`client/`, stages the root README and license, and verifies the same extension
contents. The `repository.directory` value becomes `client`.

## Migration boundary

The move is a separate implementation issue and a separate commit from this
decision. It must be one atomic repository migration:

1. move all tracked source-root contents;
2. update every checked-in command, cache, debug, metadata, and documentation
   path in the same commit;
3. do not introduce a second entrypoint or temporary wrapper; and
4. avoid unrelated code or feature changes.

The migration is complete only when:

- a fresh checkout can run `npm ci`, fast verification, Electron integration,
  and VSIX verification from the Git root;
- F5 debug paths resolve from the Git root;
- the produced VSIX has the same extension identity and required runtime files;
- no active automation, repository metadata, or current public/contributor
  instruction treats `unity-shader-nav/` as the project root; and
- no tracked content remains under the former nested directory.

## Consequences

- Contributors and agents get one high-locality entrypoint containing source,
  tests, architecture context, and commands.
- CI, debugging, packaging, and repository metadata share that same Interface,
  removing recurring path adapters.
- The migration creates a large rename-only diff and invalidates local paths or
  scripts that were never part of the public contract. Public instructions are
  updated atomically; no compatibility shim is retained.
- Future additional products should earn a new top-level boundary from an
  actual independent lifecycle. The old directory is not kept in anticipation
  of a hypothetical monorepo.
