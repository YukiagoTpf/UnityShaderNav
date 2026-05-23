# Plan 09 Code Review

Review range: `4a955881078f84b9d4d0300b2bf51383e52c48b9..c498aa14644634dc3087c99ecc5b12320436f64d`

Reviewer: code-review subagent `019e5287-2c2b-7b11-acfe-459e9d608afe`

## Summary

No P1/blocking findings.

## Findings

### P2: Standalone cache fallback is configured but not restored

`server/src/workspace/workspace.ts` configures a cache for standalone workspaces when `globalStorageDir` is available, but the standalone branch calls `bootstrapFromCache(connection, undefined)` instead of loading the manifest. Also, ordinary open-document `reindex()` writes only `store/global`, while `persist()` serializes only `diskIndexes`, so shutdown persist can write an empty standalone cache.

Impact: Plan 09 standalone `globalStorageUri` fallback acceptance is not actually satisfied.

### P2: packages-lock changes can leave old package symbols in warm cache

Cache restore validates every cached file only with `(mtime, size)`. It then scans currently resolved packages for missing files, but does not remove cached files from packages that are no longer referenced by `Packages/packages-lock.json` while their old physical directories still exist under `Library/PackageCache`.

Impact: after a restart, symbols from removed package versions can remain in the global index, regressing the Plan 08 package lifecycle semantics on the cold-start cache path.

### P3: Cache writes are only serialized inside one server process

`CacheStore` queues writes in-process, but cross-process writers can still race. On Windows, replacing the target manifest uses `rm(index.json)` before `rename(tmp, index.json)`, leaving a short no-cache window if another process or a crash lands there.

Impact: cache is rebuildable, so this is not blocking for Plan 09, but cross-process hardening remains a follow-up.

## Verification Performed

- Subagent: `npm run test -w @unity-shader-nav/server -- --run tests/cache` -> 17/17 passed.
- Main agent before review: `npm test` -> passed after fixing same-process cache write serialization.
