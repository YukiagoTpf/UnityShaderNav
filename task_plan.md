# Plan 06 Include Resolver Task Plan

Goal: complete Plan 06 include resolver, commit each plan task separately, request code-review subagent QA, record review and fix docs, run final main-agent review, then update `docs/superpowers/PROGRESS.md`.

## Phases

- [complete] Phase 1: implement Plan 06 tasks 1-10 with TDD and one commit per task.
- [complete] Phase 2: perform simple local review.
- [complete] Phase 3: request code-review subagent QA and write `plan06review.md`.
- [complete] Phase 4: request fix subagent for confirmed findings and write `plan06fix.md`.
- [complete] Phase 5: main-agent final review, full verification, update `PROGRESS.md`, and commit docs.

## Constraints

- Do not create `codex/`-prefixed branches.
- Do not remove or revert pre-existing untracked files: `AGENTS.md`, `docs/superpowers/plans/plan03review.md`, `task_plan.md`, `findings.md`, `progress.md`.
- If plan reality differs from implementation during fixes, add `> Note:` to the relevant plan document before continuing.
- Follow Plan 06 commit messages exactly where provided.
- Use one commit for review/fix/progress docs unless a code fix task requires its own commit.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| Plan glob miss. | Tried `Get-Content docs\superpowers\plans\plan06*.md`. | Read dated file `docs\superpowers\plans\2026-05-22-06-include-resolver.md`. |
