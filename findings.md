# Phase 05-10 Full Review Findings

- Lagrange subagent (05-07) found no P1, but reported two P2 findings:
  - Include indexing is block-comment aware, while include F12 scans only the current line and loses prior `/* ... */` state.
  - Settings are loaded/forwarded globally; a configured `projectRoot` can make multiple roots scan the same Unity project and break Plan 07 isolation.
- Existing Plan 05 deferred items remain deferred: CG legacy declaration patterns and unmatched macro sentinel reference noise do not currently break Phase 06/07 navigation paths.
- Faraday subagent (08-10) found no P1, but reported two P2 findings:
  - Standalone live overlays were written into disk cache and could resurrect unsaved symbols on restart.
  - Lazy workspaces used the global settings snapshot instead of scoped settings.
- Hume timeboxed subagent reclassified the two Faraday P2s as P1 and added one P2:
  - Document Symbols could return null before async open-document indexing completed.
- During focused verification, parallel tests hit a Windows `EPERM` cache rename on a shared fixture cache path. Cache writes are now best-effort at the Workspace level so cache persistence cannot break indexing/navigation.
