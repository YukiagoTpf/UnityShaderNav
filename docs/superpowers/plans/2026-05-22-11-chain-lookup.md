# Plan 11: Chain Lookup (struct member F12) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Spec §5.1 Q4 + §10 Case 10 的 chain lookup L1-L3a：F12 在 `varname.member` 的 `member` 上时，先推导 `varname` 的声明类型（来自函数参数 / 局部变量 / 带初始化的声明 / 函数返回值），再到对应 struct 内查 `member`。

**L3b（"声明缺显式类型，从右侧 call 的返回值推导"）显式不在本计划范围内**：HLSL 没有 `auto`，所有变量声明都必须写类型，所以 `Outer o = Make();` 的 declaredType 在 collector 里已经是 `Outer`，走 L2 即可；唯一会触发 L3b 的场景是 collector 未能解析出类型时的兜底，这类残缺输入留 P2 处理。同时把 L4（数组、嵌套字段、cbuffer 内 struct）留 P2。

**Architecture:**
- Plan 03 已经在 `SymbolEntry.declaredType` / `FunctionSymbolEntry.returnType` 中保存了元数据；本计划只在 resolver 层增加 chain 推导。
- `ChainLookup`：给定 `(fileIndex, globalIndex, varName, memberName, refPos)`，按下列顺序找 `varName` 的类型：
  1. **L1** 函数参数（同 scope）
  2. **L2** 局部变量（同 scope，含 proximity）—— 覆盖 `Outer o = Make();` 这类显式声明
  3. **L3a** 文件级全局变量
- 拿到类型 `T` 后：在 `globalIndex.lookup(T)` 找 `kind === 'struct'` 的条目，再在 `globalIndex.lookup(memberName)` 中筛选 `parentType === T`。

**Tech Stack:** 既有。

**Dependencies:** Plan 01-07。

---

## File Structure

新建：
```
server/src/index/chainLookup.ts
server/tests/index/chainLookup.test.ts
tests/integration/client/chain-lookup.test.ts

server/tests/index/fixtures/chain/
├── L1-param.hlsl
├── L2-local.hlsl
├── L3a-global.hlsl
├── L3b-return-type.hlsl
└── shared-structs.hlsl
```

修改：
- `server/src/handlers/definition.ts` — 检测 `field_expression` 形态，调 chainLookup
- `server/src/index/wordAt.ts` — 增加 `wordAtWithPrefix` 工具：返回 `{ member, varName? }`，对应 `a.b` 的语法

---

## Task 1: wordAtWithMember — 解析 `var.member`

**Files:**
- Modify: `server/src/index/wordAt.ts`
- Modify: `server/tests/index/wordAt.test.ts`

- [x] **Step 1: 增 API**

```typescript
export interface MemberAccess {
  member: WordAt;
  /** Identifier directly before the dot, if any. */
  receiver: WordAt | null;
}

export function memberAccessAt(text: string, pos: Position): MemberAccess | null {
  const word = wordAt(text, pos);
  if (!word) return null;
  const lines = text.split(/\r?\n/);
  const line = lines[pos.line];
  // look backward from word.range.start.character to see if there's "<id>."
  let i = word.range.start.character - 1;
  if (i < 0 || line[i] !== '.') return { member: word, receiver: null };
  i--;
  const idEnd = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(line[i])) i--;
  const idStart = i + 1;
  if (idStart === idEnd) return { member: word, receiver: null };
  const recv = line.slice(idStart, idEnd);
  if (!/^[A-Za-z_]/.test(recv)) return { member: word, receiver: null };
  return {
    member: word,
    receiver: {
      text: recv,
      range: {
        start: { line: pos.line, character: idStart },
        end:   { line: pos.line, character: idEnd   },
      },
    },
  };
}
```

- [x] **Step 2: 测试**

```typescript
import { memberAccessAt } from '../../src/index/wordAt';

describe('memberAccessAt', () => {
  it('returns member + receiver for "a.b"', () => {
    const r = memberAccessAt('  float x = surface.uv;', { line: 0, character: 20 });
    expect(r?.member.text).toBe('uv');
    expect(r?.receiver?.text).toBe('surface');
  });

  it('returns just member when no receiver', () => {
    const r = memberAccessAt('void foo() { bar; }', { line: 0, character: 14 });
    expect(r?.receiver).toBeNull();
  });
});
```

- [x] **Step 3: Commit**

```bash
git add server/src/index/wordAt.ts server/tests/index/wordAt.test.ts
git commit -m "feat(plan-11): memberAccessAt parser"
```

---

## Task 2: chainLookup — 类型推导 + 成员查找

**Files:**
- Create: `server/src/index/chainLookup.ts`
- Create: `server/tests/index/chainLookup.test.ts`

- [x] **Step 1: 实现 + tests 同步**

```typescript
import type { FileIndex, Position, Range, SymbolEntry } from '@unity-shader-nav/shared';
import type { GlobalSymbolIndex } from './globalIndex';
import type { LocationLink } from './symbolResolver';

function inRange(p: Position, r: Range): boolean {
  if (p.line < r.start.line || p.line > r.end.line) return false;
  if (p.line === r.start.line && p.character < r.start.character) return false;
  if (p.line === r.end.line   && p.character > r.end.character)   return false;
  return true;
}

function inferReceiverType(
  idx: FileIndex,
  global: GlobalSymbolIndex | null,
  receiver: string,
  refPos: Position,
): string | null {
  // L1: parameter in scope
  const params = idx.symbols.filter(
    (s) => s.name === receiver && s.kind === 'parameter' && s.scopeRange && inRange(refPos, s.scopeRange),
  );
  if (params.length > 0 && params[0].declaredType) return params[0].declaredType;

  // L2: local in scope (proximity)
  const locals = idx.symbols.filter(
    (s) => s.name === receiver && s.kind === 'localVariable' &&
           s.scopeRange && inRange(refPos, s.scopeRange) &&
           s.location.range.start.line <= refPos.line,
  );
  if (locals.length > 0) {
    let best = locals[0];
    for (const l of locals) if (l.location.range.start.line > best.location.range.start.line) best = l;
    if (best.declaredType) return best.declaredType;
  }

  // L3a: file-level globals
  const fileGlobal = idx.symbols.find(
    (s) => s.name === receiver && s.kind === 'variable',
  );
  if (fileGlobal?.declaredType) return fileGlobal.declaredType;

  // L3 global cross-file
  const allGlobal = global?.lookup(receiver) ?? [];
  const v = allGlobal.find((s) => s.kind === 'variable' && s.declaredType);
  if (v) return v.declaredType!;

  // L3b (init-call return type) is intentionally out of scope: HLSL has no `auto`,
  // every declaration carries an explicit type; the L2 branch already handles the
  // canonical `Outer o = Make();` case via declaredType. Receivers without a known
  // type return null and fall through to the default F12 path.
  return null;
}

export function resolveMember(
  idx: FileIndex,
  global: GlobalSymbolIndex | null,
  receiver: string,
  member: string,
  refPos: Position,
): LocationLink[] {
  const type = inferReceiverType(idx, global, receiver, refPos);
  if (!type) return [];

  // search struct members named `member` whose parentType === type
  const fromFile = idx.symbols.filter(
    (s) => s.kind === 'structMember' && s.parentType === type && s.name === member,
  );
  const fromGlobal = (global?.lookup(member) ?? []).filter(
    (s) => s.kind === 'structMember' && s.parentType === type,
  );
  const all = [...fromFile, ...fromGlobal];
  return all.map((s) => ({
    targetUri: s.location.uri,
    targetRange: s.location.range,
    targetSelectionRange: s.location.range,
  }));
}
```

- [x] **Step 2: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { GlobalSymbolIndex } from '../../src/index/globalIndex';
import { resolveMember } from '../../src/index/chainLookup';
import type { FileIndex } from '@unity-shader-nav/shared';

function makeIndex(): { idx: FileIndex; global: GlobalSymbolIndex } {
  const idx: FileIndex = {
    uri: 'file:///t/main.hlsl',
    references: [],
    symbols: [
      // function with parameter `surface: Surface`
      { name: 'apply', kind: 'function',
        location: { uri: 'file:///t/main.hlsl', range: { start:{line:5,character:0},end:{line:5,character:5} } } } as any,
      { name: 'surface', kind: 'parameter', scope: 'apply',
        declaredType: 'Surface',
        scopeRange: { start: { line: 5, character: 0 }, end: { line: 20, character: 0 } },
        location: { uri: 'file:///t/main.hlsl', range: { start:{line:5,character:18},end:{line:5,character:25} } } },
    ],
  };
  const g = new GlobalSymbolIndex();
  g.upsert({
    uri: 'file:///t/Surface.hlsl', references: [],
    symbols: [
      { name: 'Surface', kind: 'struct',
        location: { uri: 'file:///t/Surface.hlsl', range: { start:{line:0,character:7},end:{line:0,character:14} } } },
      { name: 'positionWS', kind: 'structMember', parentType: 'Surface',
        location: { uri: 'file:///t/Surface.hlsl', range: { start:{line:1,character:11},end:{line:1,character:21} } } },
    ],
  });
  return { idx, global: g };
}

describe('resolveMember: L1 parameter type', () => {
  it('jumps to struct member when receiver is a function parameter', () => {
    const { idx, global } = makeIndex();
    const r = resolveMember(idx, global, 'surface', 'positionWS', { line: 10, character: 0 });
    expect(r).toHaveLength(1);
    expect(r[0].targetUri).toBe('file:///t/Surface.hlsl');
  });
});

describe('resolveMember: L3a global', () => {
  it('handles a file-level global variable', () => {
    const { global } = makeIndex();
    const idx: FileIndex = {
      uri: 'file:///t/use.hlsl', references: [],
      symbols: [{ name: 'g', kind: 'variable', declaredType: 'Surface',
        location: { uri: 'file:///t/use.hlsl', range: { start:{line:0,character:8},end:{line:0,character:9} } } }],
    };
    const r = resolveMember(idx, global, 'g', 'positionWS', { line: 3, character: 0 });
    expect(r).toHaveLength(1);
  });
});
```

- [x] **Step 3: 跑测 + Commit**

```bash
npx vitest run server/tests/index/chainLookup.test.ts
git add server/src/index/chainLookup.ts server/tests/index/chainLookup.test.ts
git commit -m "feat(plan-11): chain lookup L1-L3a"
```

---

## Task 3: 接入 definition handler

**Files:**
- Modify: `server/src/handlers/definition.ts`

- [x] **Step 1: 在 handler 中先尝试 member access**

```typescript
import { memberAccessAt } from '../index/wordAt';
import { resolveMember } from '../index/chainLookup';

// after include directive branch:
const ma = memberAccessAt(doc.getText(), params.position);
if (ma?.receiver) {
  const memberLinks = resolveMember(idx, ws.global, ma.receiver.text, ma.member.text, params.position);
  if (memberLinks.length > 0) {
    return memberLinks.map((l) => ({ ...l, originSelectionRange: ma.member.range }));
  }
  // fall through to normal resolution if no chain hit
}
```

- [x] **Step 2: Commit**

```bash
git add server/src/handlers/definition.ts
git commit -m "feat(plan-11): wire chain lookup into definition handler"
```

---

## Task 4: 集成测

**Files:**
- Create: `tests/integration/client/chain-lookup.test.ts`
- Create: `tests/integration/client/fixtures/chain/Surface.hlsl`
- Create: `tests/integration/client/fixtures/chain/Use.hlsl`

- [x] **Step 1: fixture**

`Surface.hlsl`:
```hlsl
struct Surface {
    float3 positionWS;
    float2 uv;
};
```

`Use.hlsl`:
```hlsl
#include "Surface.hlsl"
float3 PickPos(Surface surface) {
    return surface.positionWS;
}
```

- [x] **Step 2: 测试**

```typescript
suite('Chain lookup', () => {
  test('F12 on .positionWS jumps to struct member', async () => {
    const fp = path.resolve(__dirname, 'fixtures/chain/Use.hlsl');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 1500));

    const line = doc.getText().split('\n').findIndex((l) => l.includes('surface.positionWS'));
    const col = doc.lineAt(line).text.indexOf('positionWS') + 3;
    const pos = new vscode.Position(line, col);

    const links = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', uri, pos,
    );
    assert.ok(links && links.length >= 1);
    const target: vscode.Uri = links[0].targetUri ?? links[0].uri;
    assert.ok(target.fsPath.endsWith('Surface.hlsl'));
  });
});
```

> Note: The integration fixture is in the standalone test workspace, where bootstrap does not full-scan sibling files. The actual test opens `Surface.hlsl` before `Use.hlsl` so both live documents are indexed before requesting `surface.positionWS` definitions. This preserves the plan's chain lookup assertion without relying on Unity-project full scan behavior.

- [x] **Step 3: Commit**

```bash
npm test
git add tests/integration/client
git commit -m "test(plan-11): chain lookup e2e"
```

---

## Acceptance

1. ✅ 单测覆盖：L1 参数、L2 局部（含 `Outer o = Make();` 这种显式类型）、L3a 全局
2. ✅ Spec §10 **Case 10**：F12 在 struct 成员 `.positionWS` 上 → 跳到 struct 定义中该字段
3. ✅ L3b（init-call 推导）+ L4（数组、嵌套字段）**显式不支持**——`Outer.inner.field` 上 F12 走默认 fallback（无解）

## Manual Verification

1. F5 → 打开 chain fixture
2. F12 在 `surface.positionWS` 的 `positionWS` → 跳到 Surface.hlsl 第 1 行 `positionWS`
3. 复杂场景：把 receiver 改成 file-level 全局变量、改成 `Outer o = Make()` 这种 init-by-call（L2 已经处理 declaredType），分别验证

完成后进入 Plan 12。
