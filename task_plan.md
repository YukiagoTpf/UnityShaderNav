# Phase 05-10 Full Review Task Plan

Goal: review Phase/Plan 05 through 10 for bugs and cross-phase consistency, record `phase05-10review.md`, request independent subagent assessment, fix confirmed P1/P2 issues, verify, and commit according to project discipline.

## Phases

- [complete] Phase 1: gather phase 05-10 docs, current implementation, git state, and existing review/fix records.
- [complete] Phase 2: run subagent read-only reviews for 05-07 and 08-10.
- [complete] Phase 3: write failing regression tests for confirmed P1/P2 issues.
- [complete] Phase 4: implement scoped fixes and update `phase05-10review.md`.
- [complete] Phase 5: run focused and full verification, update progress if needed, and commit.

## Constraints

- Do not create `codex/`-prefixed branches.
- Preserve the pre-existing `AGENTS.md` user edit.
- If plan reality differs from implementation during fixes, add `> Note:` to the relevant plan document before continuing.
- Use TDD for production bug fixes.
- Record subagent findings and final disposition in `docs/superpowers/plans/phase05-10review.md`.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| Full-history fork rejected. | Tried spawning explorer with `fork_context=true` plus explicit agent settings. | Spawned read-only explorers without forked history and included the repo/path context in prompts. |
