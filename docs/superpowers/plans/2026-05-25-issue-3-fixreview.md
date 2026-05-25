# Issue 3 Review Fixes

## Disposition

### Important: `walkFiles()` Was Not Globally Bounded

Accepted.

`walkFiles()` now uses a shared directory work queue with at most `WALK_CONCURRENCY` workers for the entire traversal. Workers sleep when the queue is temporarily empty and wake when another worker discovers child directories. Output remains sorted before returning.

Regression coverage added in `unity-shader-nav/server/tests/workspace/walkFiles.test.ts`:

- Intercepts `node:fs` `promises.readdir`.
- Builds a broad nested fixture.
- Adds a small delay so concurrent reads overlap.
- Asserts the full walk still finds all shader files.
- Asserts maximum active directory reads never exceeds 16.

Focused verification:

```text
npm run test -w @unity-shader-nav/server -- --run tests/workspace/walkFiles.test.ts
PASS: 1 file / 4 tests
```

### Minor: Same-Process Multi-Store Test Is Weaker Than Cross-Process

Documented.

The test intentionally stays same-process because unit tests cannot deterministically schedule two OS processes through final rename interleavings without becoming flaky. Cross-process hardening is covered by the implementation design: unique temp names per save, no shared temp file, direct same-directory replace, and no pre-delete `index.json` window.
