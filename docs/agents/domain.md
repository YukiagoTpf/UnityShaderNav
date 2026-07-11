# Domain Docs

This repository uses a single domain context. Engineering skills must consume its domain documentation before exploring or changing the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root for stable domain language and recommended naming.
- **`docs/adr/`** for architectural decisions relevant to the area being explored.
- **`docs/architecture.md`** when implementation topology is relevant.

If one of these files does not exist, proceed silently. Do not create domain documentation pre-emptively; producer skills create or update it only when terminology or decisions are resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   ├── architecture.md
│   └── adr/
├── client/
├── server/
├── shared/
└── tests/
```

## Use the glossary vocabulary

When output names a domain concept—in an issue title, refactoring proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`. Do not drift to synonyms that the glossary explicitly avoids.

If a required concept is absent, first reconsider whether the proposed language matches the repository. If the gap is real, record it for a domain-documentation discussion.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, surface the conflict explicitly instead of silently overriding it:

> _Contradicts ADR-0007 — but worth reopening because…_
