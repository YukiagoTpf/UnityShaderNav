# Plan 04: Single-File Go-to-Definition 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan 03 的 `FileIndex` 接进 LSP，实现"同文件内 F12"端到端：用户在一个 `.shader` 或 `.hlsl` 文件中按 F12，跳到该文件内的定义。覆盖 Spec §10 Case 1（.shader 内函数跳转）与 Case 8（函数参数跳到参数列表）。引入文件级 `SymbolIndex`（单文件版）+ Proximity tie-break + 多候选 Peek 数据通路。

**Architecture:**
- `IndexStore`：进程内 `Map<uri, FileIndex>`。文档 open/change/close/save 都同步该 store。MVP 阶段不持久化、不跨文件查询。
- `SymbolResolver`：在给定 uri + position 的情况下，先做 `getWordAtPosition`，再按"参数/局部 → 文件全局符号"的顺序查找，应用 proximity tie-break，返回 `LocationLink[]`。
- LSP `textDocument/definition` handler：纯协议适配，无业务逻辑。

> **签名演进约定（B5 防护）**：本计划首次引入的 `resolveDefinition` / `indexFile` / `registerDocuments` 把后续 plan 会扩展的参数（macro table、global index）声明为可选，本计划不使用，但参数位已就位 —— 这样 Plan 05 / 07 / 09 接入新依赖时不会再改签名。`registerDocuments` 在 Plan 07 重构为 WorkspaceManager 路由，是有意为之的重写而不是签名漂移；那里会再次显式说明。

**Tech Stack:** Plan 01/02/03 之上；新增 `vscode-languageserver-textdocument` 的 `TextDocuments` 用法（增量同步）。

**Dependencies:** Plan 01, 02, 03。

---

## File Structure

新建：
```
server/src/index/
├── indexStore.ts           # 进程内 Map<uri, FileIndex>
├── wordAt.ts               # uri/position → 标识符 token + 字符 range
├── symbolResolver.ts       # FileIndex + position → LocationLink[]
└── index.ts

server/src/handlers/
├── definition.ts           # LSP textDocument/definition handler
└── documents.ts            # TextDocuments 与 store 同步

server/tests/index/
├── wordAt.test.ts
├── symbolResolver.test.ts
└── integration.test.ts     # 一个 in-process LSP smoke

tests/integration/client/
└── definition.test.ts      # @vscode/test-electron 端到端 F12
```

修改：
- `server/src/server.ts` — 注册 documents 同步 + definition handler + 在 capabilities 中开 `definitionProvider: true`
- `client/package.json` — 无需

---

## Task 1: wordAt — 把 (uri, position) 解析成一个 identifier 范围

**Files:**
- Create: `server/src/index/wordAt.ts`
- Create: `server/tests/index/wordAt.test.ts`

- [ ] **Step 1: 失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { wordAt } from '../../src/index/wordAt';

describe('wordAt', () => {
  it('returns the identifier under cursor', () => {
    const text = 'float4 _MainTex = float4(0,0,0,1);';
    const result = wordAt(text, { line: 0, character: 9 }); // inside "_MainTex"
    expect(result?.text).toBe('_MainTex');
    expect(result?.range.start.character).toBe(7);
    expect(result?.range.end.character).toBe(15);
  });

  it('returns null when cursor is on whitespace or symbol', () => {
    expect(wordAt('a + b', { line: 0, character: 1 })).toBeNull();
  });

  it('supports identifiers with leading underscore and digits', () => {
    expect(wordAt('  _Color2', { line: 0, character: 4 })?.text).toBe('_Color2');
  });
});
```

- [ ] **Step 2: 跑挂**

- [ ] **Step 3: 实现**

```typescript
import type { Position, Range } from '@unity-shader-nav/shared';

const ID_CHAR_RE = /[A-Za-z0-9_]/;

export interface WordAt {
  text: string;
  range: Range;
}

export function wordAt(text: string, pos: Position): WordAt | null {
  const lines = text.split(/\r?\n/);
  if (pos.line < 0 || pos.line >= lines.length) return null;
  const line = lines[pos.line];
  const ch = pos.character;
  if (ch < 0 || ch > line.length) return null;

  // expand left
  let start = ch;
  while (start > 0 && ID_CHAR_RE.test(line[start - 1])) start--;
  // expand right (only if current pos is on an id-char OR we found chars to the left)
  let end = ch;
  while (end < line.length && ID_CHAR_RE.test(line[end])) end++;

  if (start === end) return null;
  const word = line.slice(start, end);
  if (!/^[A-Za-z_]/.test(word)) return null;

  return {
    text: word,
    range: {
      start: { line: pos.line, character: start },
      end:   { line: pos.line, character: end   },
    },
  };
}
```

> Note: Task 1 的计划实现片段会在光标位于空白时向左扩展并返回前一个 identifier，但同一 Task 的测试明确要求 whitespace/symbol 返回 `null`。实际实现以测试语义为准：只有光标当前字符是 identifier 字符时才扩展。

- [ ] **Step 4: 跑过**

```bash
npx vitest run server/tests/index/wordAt.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add server/src/index/wordAt.ts server/tests/index/wordAt.test.ts
git commit -m "feat(plan-04): wordAt helper for identifier extraction"
```

---

## Task 2: IndexStore

**Files:**
- Create: `server/src/index/indexStore.ts`
- Create: `server/src/index/index.ts`

- [ ] **Step 1: 实现**

```typescript
import type { FileIndex } from '@unity-shader-nav/shared';

export class IndexStore {
  private readonly byUri = new Map<string, FileIndex>();

  set(uri: string, idx: FileIndex): void {
    this.byUri.set(uri, idx);
  }

  get(uri: string): FileIndex | undefined {
    return this.byUri.get(uri);
  }

  delete(uri: string): void {
    this.byUri.delete(uri);
  }

  uris(): IterableIterator<string> {
    return this.byUri.keys();
  }
}
```

- [ ] **Step 2: 写 `server/src/index/index.ts`**

```typescript
export { IndexStore } from './indexStore';
export { wordAt } from './wordAt';
export type { WordAt } from './wordAt';
export { resolveDefinition } from './symbolResolver';
```

> 注意：`resolveDefinition` 在 Task 3 写完再编译；先在 index.ts 留个引用，会编译失败——下一 Task 写完再 build。

- [ ] **Step 3: Commit（store 单独提交）**

```bash
git add server/src/index/indexStore.ts
git commit -m "feat(plan-04): IndexStore (in-memory)"
```

---

## Task 3: SymbolResolver — 单文件查找 + Proximity tie-break

**Files:**
- Create: `server/src/index/symbolResolver.ts`
- Create: `server/tests/index/symbolResolver.test.ts`

- [ ] **Step 1: 失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import type { FileIndex, Position, SymbolEntry } from '@unity-shader-nav/shared';
import { resolveDefinition } from '../../src/index/symbolResolver';

function sym(over: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return {
    location: { uri: 'file:///t/x.hlsl', range: { start: {line:0,character:0}, end: {line:0,character:0} } },
    ...over,
  } as SymbolEntry;
}

describe('resolveDefinition: same-file function', () => {
  it('returns the function symbol when name matches', () => {
    const idx: FileIndex = {
      uri: 'file:///t/x.hlsl',
      symbols: [sym({
        name: 'add', kind: 'function',
        location: { uri: 'file:///t/x.hlsl', range: { start:{line:5,character:7}, end:{line:5,character:10} } },
      })],
      references: [],
    };
    const result = resolveDefinition(idx, 'add', { line: 10, character: 4 });
    expect(result).toHaveLength(1);
    expect(result[0].targetUri).toBe('file:///t/x.hlsl');
    expect(result[0].targetRange.start.line).toBe(5);
  });
});

describe('resolveDefinition: proximity tie-break for locals', () => {
  it('picks the local declaration with the largest line <= reference line', () => {
    const scopeRange = { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } };
    const idx: FileIndex = {
      uri: 'file:///t/x.hlsl',
      symbols: [
        sym({
          name: 'i', kind: 'localVariable', scope: 'f', scopeRange,
          location: { uri: 'file:///t/x.hlsl', range: { start:{line:3,character:8}, end:{line:3,character:9} } },
        }),
        sym({
          name: 'i', kind: 'localVariable', scope: 'f', scopeRange,
          location: { uri: 'file:///t/x.hlsl', range: { start:{line:7,character:8}, end:{line:7,character:9} } },
        }),
      ],
      references: [],
    };
    // reference is on line 10 — should pick line 7 (closer, still <= 10)
    const result = resolveDefinition(idx, 'i', { line: 10, character: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].targetRange.start.line).toBe(7);
  });
});

describe('resolveDefinition: multi-candidate for global names', () => {
  it('returns all matching global functions when multiple share a name (different scopes)', () => {
    const idx: FileIndex = {
      uri: 'file:///t/x.shader',
      symbols: [
        sym({ name: 'vert', kind: 'function',
              location: { uri: 'file:///t/x.shader', range: { start:{line:10,character:0},end:{line:10,character:4} } } }),
        sym({ name: 'vert', kind: 'function',
              location: { uri: 'file:///t/x.shader', range: { start:{line:30,character:0},end:{line:30,character:4} } } }),
      ],
      references: [],
    };
    const result = resolveDefinition(idx, 'vert', { line: 12, character: 1 });
    expect(result).toHaveLength(2);
  });
});

describe('resolveDefinition: parameter then global', () => {
  it('parameter inside its scope shadows same-name global', () => {
    const scopeRange = { start: { line: 5, character: 0 }, end: { line: 15, character: 0 } };
    const idx: FileIndex = {
      uri: 'file:///t/x.hlsl',
      symbols: [
        sym({ name: 'x', kind: 'variable',
              location: { uri: 'file:///t/x.hlsl', range: { start:{line:0,character:7},end:{line:0,character:8} } } }),
        sym({ name: 'x', kind: 'parameter', scope: 'f', scopeRange,
              location: { uri: 'file:///t/x.hlsl', range: { start:{line:5,character:20},end:{line:5,character:21} } } }),
      ],
      references: [],
    };
    const result = resolveDefinition(idx, 'x', { line: 10, character: 4 });
    expect(result).toHaveLength(1);
    expect(result[0].targetRange.start.line).toBe(5);
  });
});
```

- [ ] **Step 2: 跑挂**

- [ ] **Step 3: 实现**

```typescript
import type { FileIndex, Position, Range, SymbolEntry } from '@unity-shader-nav/shared';

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  /** Range to select once jumped (defaults to identifier range). */
  targetSelectionRange: Range;
}

function inRange(p: Position, r: Range): boolean {
  if (p.line < r.start.line || p.line > r.end.line) return false;
  if (p.line === r.start.line && p.character < r.start.character) return false;
  if (p.line === r.end.line && p.character > r.end.character) return false;
  return true;
}

function isBefore(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function asLink(s: SymbolEntry): LocationLink {
  return {
    targetUri: s.location.uri,
    targetRange: s.location.range,
    targetSelectionRange: s.location.range,
  };
}

export function resolveDefinition(
  idx: FileIndex,
  name: string,
  refPos: Position,
  // The following two params are reserved for forward compatibility; Plan 04
  // never uses them. Plan 07 wires global cross-file fallback through `global`;
  // Plan 13 may add a config flag. Keep param positions stable so Plan 07 can
  // extend behavior without changing the signature.
  _global?: unknown,
): LocationLink[] {
  const candidates = idx.symbols.filter((s) => s.name === name);
  if (candidates.length === 0) return [];

  // 1) function-scoped first (parameters / locals) where refPos ∈ scopeRange
  const scoped = candidates.filter(
    (s) =>
      (s.kind === 'parameter' || s.kind === 'localVariable') &&
      s.scopeRange &&
      inRange(refPos, s.scopeRange) &&
      isBefore(s.location.range.start, refPos),
  );

  if (scoped.length > 0) {
    // proximity tie-break: largest declaration line <= refPos line
    let best = scoped[0];
    for (const s of scoped) {
      const sLine = s.location.range.start.line;
      const bLine = best.location.range.start.line;
      if (sLine > bLine) best = s;
    }
    return [asLink(best)];
  }

  // 2) file-level globals & types: return all matches (multi-candidate Peek, ADR-0001)
  const globals = candidates.filter(
    (s) => s.kind !== 'parameter' && s.kind !== 'localVariable',
  );
  return globals.map(asLink);
}
```

- [ ] **Step 4: 跑测试**

```bash
npm run build -w @unity-shader-nav/server
npx vitest run server/tests/index/symbolResolver.test.ts
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/index/symbolResolver.ts server/src/index/index.ts server/tests/index/symbolResolver.test.ts
git commit -m "feat(plan-04): symbol resolver with proximity tie-break"
```

---

## Task 4: documents.ts — TextDocuments ↔ IndexStore 同步

**Files:**
- Create: `server/src/handlers/documents.ts`

- [ ] **Step 1: 实现**

```typescript
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Connection } from 'vscode-languageserver/node';
import { indexFile } from '../parser/hlsl';
import { IndexStore } from '../index';

export function registerDocuments(
  connection: Connection,
  store: IndexStore,
): TextDocuments<TextDocument> {
  const documents = new TextDocuments(TextDocument);

  const reindex = async (doc: TextDocument): Promise<void> => {
    const idx = await indexFile(doc.uri, doc.getText());
    store.set(doc.uri, idx);
    connection.console.log(
      `[index] ${doc.uri} → ${idx.symbols.length} symbols, ${idx.references.length} refs`,
    );
  };

  documents.onDidOpen((e) => { void reindex(e.document); });
  documents.onDidChangeContent((e) => { void reindex(e.document); });
  documents.onDidClose((e) => { store.delete(e.document.uri); });

  documents.listen(connection);
  return documents;
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/handlers/documents.ts
git commit -m "feat(plan-04): document sync to IndexStore"
```

---

## Task 5: definition handler

**Files:**
- Create: `server/src/handlers/definition.ts`

- [ ] **Step 1: 实现**

```typescript
import type { Connection } from 'vscode-languageserver/node';
import {
  type DefinitionParams,
  type LocationLink,
  type Location,
} from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { wordAt, resolveDefinition, IndexStore } from '../index';

export function registerDefinitionHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  store: IndexStore,
): void {
  connection.onDefinition((params: DefinitionParams): LocationLink[] | Location[] | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const idx = store.get(params.textDocument.uri);
    if (!idx) return null;

    const word = wordAt(doc.getText(), params.position);
    if (!word) return null;

    const links = resolveDefinition(idx, word.text, params.position);
    if (links.length === 0) return null;

    return links.map((l) => ({
      targetUri: l.targetUri,
      targetRange: l.targetRange,
      targetSelectionRange: l.targetSelectionRange,
      originSelectionRange: word.range,
    }));
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/handlers/definition.ts
git commit -m "feat(plan-04): textDocument/definition handler"
```

---

## Task 6: wiring 到 server.ts + capability

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/connection.ts`

> Note: 当前 `connection.ts` 已在 plan01fix 中改成 lazy `getConnection()`，避免 vitest 模块加载期创建无 transport 的 LSP connection。Task 6 实施时保留该现实结构，只在 `createInitializeResult()` 增加 `definitionProvider: true`，并在 `server.ts` 使用 `getConnection()` 接线。

- [ ] **Step 1: 修改 `connection.ts` 增加 `definitionProvider`**

```typescript
import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { SERVER_NAME } from '@unity-shader-nav/shared';

export const connection = createConnection(ProposedFeatures.all);

export function createInitializeResult(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
    },
    serverInfo: { name: SERVER_NAME, version: '0.0.1' },
  };
}
```

- [ ] **Step 2: 修改 `server.ts`**

```typescript
import { connection, createInitializeResult } from './connection';
import { IndexStore } from './index';
import { registerDocuments } from './handlers/documents';
import { registerDefinitionHandler } from './handlers/definition';

const store = new IndexStore();

connection.onInitialize(() => createInitializeResult());

connection.onInitialized(() => {
  connection.console.log('[UnityShaderNav] server initialized');
});

const documents = registerDocuments(connection, store);
registerDefinitionHandler(connection, documents, store);

connection.listen();
```

- [ ] **Step 3: 测试 capabilities 在 handshake**

修改 `server/tests/handshake.test.ts`：

```typescript
it('advertises definitionProvider', () => {
  const r = createInitializeResult();
  expect(r.capabilities.definitionProvider).toBe(true);
});
```

跑测试，PASS。

- [ ] **Step 4: build 全过**

```bash
npm run build -w @unity-shader-nav/server
```

- [ ] **Step 5: Commit**

```bash
git add server/src/{server.ts,connection.ts} server/tests/handshake.test.ts
git commit -m "feat(plan-04): wire definition handler in server"
```

---

## Task 7: in-process LSP smoke

**Files:**
- Create: `server/tests/index/integration.test.ts`

- [ ] **Step 1: 测试**

直接调用 handler 链，不起 LSP 进程：

```typescript
import { describe, it, expect } from 'vitest';
import { IndexStore } from '../../src/index';
import { indexFile } from '../../src/parser/hlsl';
import { wordAt } from '../../src/index/wordAt';
import { resolveDefinition } from '../../src/index/symbolResolver';

describe('e2e (in-process): F12 inside .hlsl', () => {
  it('jumps from call site to function declaration', async () => {
    const uri = 'file:///t/x.hlsl';
    const text = `
float4 add(float4 a, float4 b) { return a + b; }
float4 main() { return add(float4(0,0,0,1), float4(1,1,1,1)); }
`.trim();

    const store = new IndexStore();
    store.set(uri, await indexFile(uri, text));

    // call site: line 1 (0-based), inside "add" of "add(float4..."
    const pos = { line: 1, character: 24 };
    const word = wordAt(text, pos);
    expect(word?.text).toBe('add');

    const links = resolveDefinition(store.get(uri)!, word!.text, pos);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].targetUri).toBe(uri);
    expect(links[0].targetRange.start.line).toBe(0); // declaration is line 0
  });
});
```

- [ ] **Step 2: 跑测试 + 调整字符列位**

```bash
npx vitest run server/tests/index/integration.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add server/tests/index/integration.test.ts
git commit -m "test(plan-04): in-process F12 smoke"
```

---

## Task 8: 端到端 client-side 集成测（test-electron）

**Files:**
- Create: `tests/integration/client/fixtures/single-file/test.hlsl`
- Create: `tests/integration/client/fixtures/multi-pass-test.shader`
- Create: `tests/integration/client/definition.test.ts`

- [ ] **Step 1: fixture `test.hlsl`**

```hlsl
float4 helper(float4 v) { return v * 2.0; }
float4 main() {
    float4 x = float4(1,1,1,1);
    return helper(x);
}
```

(`helper` 在第 0 行，列 7-13；`helper(x)` 调用点在第 3 行)

- [ ] **Step 2: fixture `multi-pass-test.shader`**

复用 Plan 02 的 multi-pass 模板。注意：Plan 04 阶段还没有 macro pattern recognizer（在 Plan 05），所以**不能**依赖 `#pragma vertex vert` 来产生引用。fixture 在每个 Pass 块里多加一行 `vert();` 调用，这样 collector 把它当作 call_expression reference 收进 FileIndex，下面的测试就能在调用位置上 F12。

```hlsl
Shader "Test/MultiPassDefn" {
  SubShader {
    Pass {
      Name "ForwardLit"
      HLSLPROGRAM
      void vert() {}
      void main_forward() { vert(); }
      ENDHLSL
    }
    Pass {
      Name "ShadowCaster"
      HLSLPROGRAM
      void vert() {}
      void main_shadow() { vert(); }
      ENDHLSL
    }
  }
}
```

记录 `vert();` 调用点的行（启动测试前先 `cat -n` 确认）：约第 6 行和第 12 行（0-based）。

- [ ] **Step 3: 测试**

```typescript
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import * as path from 'node:path';

suite('F12 single-file', () => {
  test('jumps from call to declaration in .hlsl', async () => {
    const fp = path.resolve(__dirname, 'fixtures/single-file/test.hlsl');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    // wait for server to index
    await new Promise((r) => setTimeout(r, 800));

    const position = new vscode.Position(3, 12); // inside "helper(x)"
    const links = await vscode.commands.executeCommand<vscode.LocationLink[] | vscode.Location[]>(
      'vscode.executeDefinitionProvider', uri, position,
    );

    assert.ok(links && links.length >= 1, 'expected at least one definition');
    const first = links[0] as vscode.LocationLink;
    const targetRange = first.targetRange ?? (first as any).range;
    assert.strictEqual(targetRange.start.line, 0);
  });

  test('multi-pass .shader returns 2 candidates for vert', async () => {
    const fp = path.resolve(__dirname, 'fixtures/multi-pass-test.shader');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 800));

    const text = doc.getText();
    const lines = text.split(/\r?\n/);

    // Find the first `vert();` call site (inside ForwardLit pass).
    const callLine = lines.findIndex((l, idx) =>
      idx > 0 && lines[idx - 1].includes('main_forward()') === false && l.includes('vert();'),
    );
    assert.ok(callLine >= 0, 'expected a vert() call site in fixture');
    const callCol = lines[callLine].indexOf('vert();') + 1; // inside the word "vert"

    const links = await vscode.commands.executeCommand<vscode.LocationLink[] | vscode.Location[]>(
      'vscode.executeDefinitionProvider', uri, new vscode.Position(callLine, callCol),
    );
    assert.ok(links, 'definition provider returned null');
    // Each Pass has its own `void vert() {}` declaration → multi-candidate Peek (ADR-0001)
    assert.strictEqual(links.length, 2, `expected 2 vert candidates, got ${links.length}`);

    // Both candidates point at the same .shader uri, at different lines.
    const linesOut = links.map((l) =>
      ((l as vscode.LocationLink).targetRange ?? (l as any).range).start.line,
    );
    assert.notStrictEqual(linesOut[0], linesOut[1]);
  });
});
```

> 这里 `multi-pass .shader` 用例不依赖 Plan 05；Plan 05 完成后会另开一个 case 测试 `#pragma vertex vert` 的引用。

- [ ] **Step 4: 跑测试**

```bash
npm test -w unity-shader-nav -- --grep "F12 single-file"
```

预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add tests/integration/client
git commit -m "test(plan-04): end-to-end F12 via test-electron"
```

---

## Acceptance

1. ✅ `npm test`（vitest + test-electron）全部通过
2. ✅ Spec §10 **Case 1**：在 .shader 的 HLSLPROGRAM 内 F12 同文件函数 → 跳转成功
3. ✅ Spec §10 **Case 8**：F12 在函数参数 identifier 上 → 跳到所属函数参数列表
4. ✅ 多候选情况（同文件多个同名函数）返回 ≥ 2 个 LocationLink
5. ✅ Proximity tie-break：函数体内多个同名局部，按"最近 ≤ refLine"返回唯一答案

对应 Spec §10 验收：Case 1, Case 8（核心）；为 Case 5/6/7 提供管线但 macro pattern 在 Plan 05。

## Manual Verification

1. F5 启动 Extension Development Host
2. 打开 `tests/integration/client/fixtures/single-file/test.hlsl`
3. 把光标放在第 3 行 `helper(x)` 的 `helper` 上，按 F12
4. 应跳到第 0 行 `helper` 函数声明处
5. 把光标放在第 0 行函数参数 `v` 的某个使用点（如有），按 F12，应跳到参数声明处
6. 打开 Plan 02 的 `multi-pass.shader`，在某个 HLSLPROGRAM 块内某 `vert` 调用上按 F12，弹出 VSCode 原生 Peek，列出 2 个 `vert` 候选

任一项失败则本计划未完成。
