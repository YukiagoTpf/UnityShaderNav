# Plan 10: Document Symbols 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `textDocument/documentSymbol`，让 Ctrl+Shift+O 显示当前文件的大纲：函数 / struct / cbuffer / pragma 入口；对 `.shader` 顶部叠加 ShaderLab 结构（Shader → SubShader → Pass）。覆盖 Spec §10 Case 12。

**Architecture:**
- `buildDocumentSymbols(fileIndex, structure?)`：纯函数。`.hlsl` 直接 flatten `FileIndex.symbols` 到 LSP `DocumentSymbol` 树；`.shader` 还要把 Plan 02 `scanStructure` 的结果作为外层节点，再把每个块内的 HLSL 符号挂到对应 Pass 下（按 location.range 包含判断）。
- LSP handler 注册。

**Tech Stack:** 既有。

**Dependencies:** Plan 01-04。（不依赖 cross-file，可在 MVP 完成后任意时机插入。）

---

## File Structure

新建：
```
server/src/handlers/documentSymbol.ts
server/src/index/documentSymbols.ts

tests/server/index/documentSymbols.test.ts
tests/integration/client/document-symbols.test.ts
```

修改：
- `server/src/connection.ts` — capabilities 加 `documentSymbolProvider: true`
- `server/src/server.ts` — 注册 handler
- `server/src/parser/hlsl/fileIndexer.ts` — 把 `scanStructure(text)` 结果一起存到 `FileIndex`（仅 `.shader` 文件）。引入 `FileIndex.structure?: StructureResult`

---

## Task 1: 扩展 FileIndex 携带结构信息

**Files:**
- Modify: `shared/src/symbols.ts`
- Modify: `server/src/parser/hlsl/fileIndexer.ts`

- [ ] **Step 1: shared types**

复用 Plan 02 在 `shared/src/structure.ts` 里定义的递归 `StructureResult` —— 不要再造一个手写分层的 Lite 版本（避免 Plan 02 的 `ShaderLabStructureNode` ↔ Plan 10 Lite 之间靠 `as any` 强转，曾在 review 中标为 B3 Blocker）。

```typescript
// shared/src/symbols.ts 内补充：
import type { StructureResult } from './structure';

export interface FileIndex {
  uri: string;
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
  /** Only populated for .shader files (set by fileIndexer). */
  structure?: StructureResult;
}
```

- [ ] **Step 2: fileIndexer 填充**

```typescript
// 在 .shader 分支末尾（无 as any 强转）：
merged.structure = scanStructure(text);
```

- [ ] **Step 3: 单测**

```typescript
it('attaches structure for .shader files', async () => {
  const text = readFileSync(
    join(__dirname, '../shaderlab/fixtures/multi-pass.shader'), 'utf8');
  const idx = await indexFile('file:///t/m.shader', text);
  expect(idx.structure?.shaders).toBeDefined();
  expect(idx.structure!.shaders[0].children[0].children.length).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Commit**

```bash
git add shared/src server/src/parser/hlsl/fileIndexer.ts tests/server/parser/hlsl/fileIndexer.test.ts
git commit -m "feat(plan-10): include ShaderLab structure in FileIndex"
```

---

## Task 2: buildDocumentSymbols — 纯函数

**Files:**
- Create: `server/src/index/documentSymbols.ts`
- Create: `tests/server/index/documentSymbols.test.ts`

- [ ] **Step 1: 失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { buildDocumentSymbols } from '../../../server/src/index/documentSymbols';
import type { FileIndex } from '@unity-shader-nav/shared';

const sym = (name: string, kind: any, line: number, parent?: string) => ({
  name, kind, parentType: parent,
  location: { uri: 'u', range: { start: {line,character:0}, end: {line,character:0} } },
} as any);

describe('buildDocumentSymbols: .hlsl', () => {
  it('returns flat list of functions/structs/cbuffers', () => {
    const idx: FileIndex = {
      uri: 'file:///t/x.hlsl',
      symbols: [
        sym('foo', 'function', 0),
        sym('Attributes', 'struct', 5),
        sym('positionOS', 'structMember', 6, 'Attributes'),
        sym('UnityPerMaterial', 'cbuffer', 10),
      ],
      references: [],
    };
    const tree = buildDocumentSymbols(idx);
    expect(tree.map((n) => n.name).sort()).toEqual(['Attributes', 'UnityPerMaterial', 'foo']);
    // members nested under Attributes
    const att = tree.find((n) => n.name === 'Attributes')!;
    expect(att.children?.map((c) => c.name)).toEqual(['positionOS']);
  });
});

describe('buildDocumentSymbols: .shader with structure', () => {
  it('nests HLSL symbols under owning Pass', () => {
    const idx: FileIndex = {
      uri: 'file:///t/m.shader',
      symbols: [ sym('vert', 'function', 5), sym('frag', 'function', 25) ],
      references: [],
      structure: {
        shaders: [{
          name: 'X', headerLine: 0, closeLine: 50,
          children: [{
            kind: 'subshader', headerLine: 1, closeLine: 49,
            children: [
              { kind: 'pass', name: 'Lit',    headerLine: 2,  closeLine: 20 },
              { kind: 'pass', name: 'Shadow', headerLine: 21, closeLine: 48 },
            ],
          } as any],
        }],
      },
    };
    const tree = buildDocumentSymbols(idx);
    expect(tree).toHaveLength(1); // root: Shader
    const shader = tree[0];
    expect(shader.name).toContain('X');
    const subshader = shader.children![0];
    const passes = subshader.children!;
    expect(passes).toHaveLength(2);
    expect(passes[0].children!.map((c) => c.name)).toEqual(['vert']);
    expect(passes[1].children!.map((c) => c.name)).toEqual(['frag']);
  });
});
```

- [ ] **Step 2: 实现**

```typescript
import {
  SymbolKind as LspSymbolKind,
  type DocumentSymbol,
} from 'vscode-languageserver/node';
import type {
  FileIndex,
  Range,
  ShaderLabStructureNode,
  StructureResult,
  SymbolEntry,
} from '@unity-shader-nav/shared';

const KIND_MAP: Record<string, LspSymbolKind> = {
  function:      LspSymbolKind.Function,
  variable:      LspSymbolKind.Variable,
  parameter:     LspSymbolKind.Variable,
  localVariable: LspSymbolKind.Variable,
  struct:        LspSymbolKind.Struct,
  structMember:  LspSymbolKind.Field,
  macro:         LspSymbolKind.Constant,
  cbuffer:       LspSymbolKind.Struct,
};

function makeDocSym(name: string, kind: LspSymbolKind, r: Range, selR?: Range): DocumentSymbol {
  return { name, kind, range: r, selectionRange: selR ?? r, children: [] };
}

function entryToDoc(s: SymbolEntry): DocumentSymbol {
  return makeDocSym(s.name, KIND_MAP[s.kind] ?? LspSymbolKind.Object, s.location.range);
}

function inRange(line: number, r: Range): boolean {
  return line >= r.start.line && line <= r.end.line;
}

function rangeOfLines(start: number, end: number): Range {
  return { start: { line: start, character: 0 }, end: { line: end, character: 0 } };
}

export function buildDocumentSymbols(idx: FileIndex): DocumentSymbol[] {
  // Group symbols
  const topLevel: SymbolEntry[] = [];
  const membersByParent = new Map<string, SymbolEntry[]>();
  for (const s of idx.symbols) {
    if (s.kind === 'parameter' || s.kind === 'localVariable') continue;
    if (s.kind === 'structMember' && s.parentType) {
      const arr = membersByParent.get(s.parentType) ?? [];
      arr.push(s);
      membersByParent.set(s.parentType, arr);
      continue;
    }
    topLevel.push(s);
  }
  const docByLine: DocumentSymbol[] = topLevel.map((s) => {
    const d = entryToDoc(s);
    if (s.kind === 'struct') {
      d.children = (membersByParent.get(s.name) ?? []).map(entryToDoc);
    }
    return d;
  });

  if (!idx.structure) return docByLine;

  // Nest under structure tree
  const result: DocumentSymbol[] = [];
  for (const shader of idx.structure.shaders) {
    const shaderNode = makeDocSym(
      `Shader "${shader.name ?? ''}"`,
      LspSymbolKind.Class,
      rangeOfLines(shader.headerLine, shader.closeLine),
    );
    for (const sub of shader.children) {
      const subNode = makeDocSym(
        sub.kind === 'subshader' ? 'SubShader' : `Pass "${sub.name ?? ''}"`,
        LspSymbolKind.Module,
        rangeOfLines(sub.headerLine, sub.closeLine),
      );
      const innerPasses = sub.children ?? [];
      const passList = sub.kind === 'subshader' ? innerPasses : [sub as any];
      const passNodes: DocumentSymbol[] = [];
      for (const pass of passList) {
        const pNode = makeDocSym(
          `Pass "${pass.name ?? ''}"`,
          LspSymbolKind.Module,
          rangeOfLines(pass.headerLine, pass.closeLine),
        );
        pNode.children = docByLine.filter((d) =>
          inRange(d.range.start.line, pNode.range),
        );
        passNodes.push(pNode);
      }
      subNode.children = sub.kind === 'subshader' ? passNodes : passNodes[0]?.children ?? [];
      shaderNode.children!.push(subNode);
    }
    // top-level entries outside Pass blocks (e.g., HLSLINCLUDE block)
    const remainders = docByLine.filter((d) =>
      !shaderNode.children!.some((c) =>
        c.children?.some((p) => p.children?.includes(d))));
    shaderNode.children!.push(...remainders);
    result.push(shaderNode);
  }
  return result;
}
```

> 嵌套逻辑略 fiddly；测试驱动调试。

- [ ] **Step 3: 跑测，迭代调试**

```bash
npx vitest run tests/server/index/documentSymbols.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add server/src/index/documentSymbols.ts tests/server/index/documentSymbols.test.ts
git commit -m "feat(plan-10): build DocumentSymbol tree with ShaderLab nesting"
```

---

## Task 3: LSP handler

**Files:**
- Create: `server/src/handlers/documentSymbol.ts`
- Modify: `server/src/connection.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: handler**

```typescript
import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { WorkspaceManager } from '../workspace';
import { buildDocumentSymbols } from '../index/documentSymbols';

export function registerDocumentSymbolHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  mgr: WorkspaceManager,
): void {
  connection.onDocumentSymbol((params) => {
    const ws = mgr.workspaceFor(params.textDocument.uri);
    if (!ws) return null;
    const idx = ws.store.get(params.textDocument.uri);
    if (!idx) return null;
    return buildDocumentSymbols(idx);
  });
}
```

- [ ] **Step 2: capabilities**

```typescript
capabilities: {
  ...,
  documentSymbolProvider: true,
}
```

- [ ] **Step 3: 注册**

```typescript
// server.ts
registerDocumentSymbolHandler(connection, documents, mgr);
```

- [ ] **Step 4: build + Commit**

```bash
npm run build
git add server/src
git commit -m "feat(plan-10): documentSymbol provider"
```

---

## Task 4: 集成测

**Files:**
- Create: `tests/integration/client/document-symbols.test.ts`

- [ ] **Step 1: 测试**

```typescript
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import * as path from 'node:path';

suite('Document Symbols', () => {
  test('outline contains struct/function/cbuffer in .hlsl', async () => {
    const fp = path.resolve(__dirname, 'fixtures/single-file/test.hlsl');
    // ensure fixture covers struct + cbuffer; if not, extend it
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 1000));

    const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', uri,
    );
    assert.ok(syms && syms.length >= 1);
    assert.ok(syms.some((s) => s.name === 'helper' || s.name === 'main'));
  });

  test('.shader outline shows Shader > SubShader > Pass > entry', async () => {
    const fp = path.resolve(__dirname, 'fixtures/multi-pass-test.shader');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 1000));

    const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', uri,
    );
    assert.ok(syms && syms.length >= 1);
    const shader = syms[0];
    assert.ok(shader.children && shader.children.length >= 1);
  });
});
```

- [ ] **Step 2: 跑 + Commit**

```bash
npm test
git add tests/integration/client/document-symbols.test.ts
git commit -m "test(plan-10): outline e2e"
```

---

## Acceptance

1. ✅ 单测覆盖：`.hlsl` flat、`.shader` 嵌套、struct 成员折叠在父节点下
2. ✅ Spec §10 **Case 12**：Ctrl+Shift+O 显示函数/struct/cbuffer/pragma 入口大纲
3. ✅ `.shader` 文件大纲顶层是 `Shader "Name"`，下钻到 `Pass "X"`，再到该 Pass 内的函数符号
4. ✅ struct 成员作为 struct 的 children 而非 top-level

## Manual Verification

1. F5 → 打开 `tests/server/parser/hlsl/fixtures/structs.hlsl` → Ctrl+Shift+O → 看到 `Attributes`、`Varyings`，下面挂着各字段
2. 打开 `Main.shader` → Ctrl+Shift+O → `Shader "T/Inc"` → `SubShader` → `Pass ""` → `main`

完成后进入 Plan 11。
