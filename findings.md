# Plan 06 Include Resolver Findings

- Plan 06 file uses `server/tests/include/...` for resolver fixtures and `server/tests/parser/include/...` for scanner tests under `unity-shader-nav/`.
- Current `definition.ts` only resolves identifiers via `wordAt`; include string F12 must run before the existing symbol path because `wordAt` returns null inside quoted path separators or may grab a partial word.
- Current `fileIndexer.ts` already scans pragma references with block offsets; include references can follow the same merge pattern.
