# Issue 9 Chain Lookup Findings

- GitHub issue #9 is open: "Extend chain lookup for arrays, nested fields, cbuffer structs, and RHS inference".
- Acceptance criteria: failing tests first for each supported chain shape; resolve by receiver type, not name-only lookup; preserve L1/L2/L3a behavior; document intentionally unsupported shapes.
- Project progress says #9 is related to L3b/L4 follow-up and should build on the #2 struct type/member fixes.
- Current working branch: `issue-9-chain-lookup` created from `main`; it avoids the prohibited `codex/` prefix.
- Existing `memberAccessAt()` only recognizes `identifier.member`; arrays and nested chains fail before `resolveMember()` gets useful receiver information.
- Existing `collector.receiverName()` only records member reference receivers when the field expression argument is a direct identifier; references for `lights[i].color` and `surface.brdfData.roughness` cannot be type-filtered today.
- Existing `inferReceiverType()` only resolves parameter/local/global declared types. It does not follow a struct member's declared type for nested chains and does not infer an unknown receiver from a preceding `receiver = MakeSurface()` call assignment.
- Tree-sitter shapes confirmed:
  - `lights[i].color`: outer `field_expression.argument` is a `subscript_expression` whose argument is identifier `lights`.
  - `surface.brdfData.roughness`: nested `field_expression` argument is another `field_expression`.
  - `cbuffer Params { Settings settings; }` is still parsed by the existing cbuffer fallback, and the inner `Settings settings` can be collected as a global `variable` with `declaredType`.
  - `surface = MakeSurface(); surface.positionWS` exposes an `assignment_expression` with identifier left and `call_expression` right, which can support a local RHS-call inference fallback.
- `docs/superpowers/plans/2026-05-23-overall-consistency-fixes.md` Task 5.5 says to implement RHS call return type inference before nested arrays/fields, then add an Electron smoke after unit behavior is stable.
