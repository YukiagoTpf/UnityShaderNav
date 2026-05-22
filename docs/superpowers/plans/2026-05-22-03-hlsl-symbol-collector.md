# Plan 03: HLSL Symbol Collector 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 HLSL 符号收集器：给定一个 HLSL 源代码块（或一个 `.hlsl/.cginc/.hlslinc/.compute` 文件），调用 `tree-sitter-hlsl` 解析为 AST，遍历提取所有符号（函数、struct、cbuffer、参数、局部变量）和引用（call/type/member/identifier），输出符合 Spec §5.3 的 `FileIndex`。同时对接 Plan 02 的 `scanBlocks`，让 `.shader` 文件能被正确"展平"为单一文件级符号表（ADR-0001）。

**Architecture:** 三层：
1. **Parser 适配层** (`hlsl/parser.ts`)：封装 `web-tree-sitter` 的初始化与 parse 调用，缓存 Language 单例。
2. **Symbol Collector** (`hlsl/collector.ts`)：遍历 tree-sitter AST，把节点映射成 `SymbolEntry[]` + `ReferenceEntry[]`。
3. **File Indexer** (`hlsl/fileIndexer.ts`)：接受文件路径与内容，先用 `scanBlocks` 切出 HLSL 内容范围（`.shader`）或直接走全文（`.hlsl` 等），然后调 collector，合并结果，处理跨块行偏移。

**Tech Stack:** `web-tree-sitter` ^0.22，`tree-sitter-hlsl` 预编译的 WASM 文件随仓库分发到 `server/grammars/tree-sitter-hlsl.wasm`。

**Dependencies:** Plan 01, Plan 02。

---

## File Structure

新建：

```
server/grammars/
└── tree-sitter-hlsl.wasm                 # 预编译 WASM；由 build 脚本/手动放入

server/src/parser/hlsl/
├── parser.ts                             # web-tree-sitter 单例 + parse(text) → Tree
├── nodeHelpers.ts                        # AST 节点工具：textOf, rangeOf, walk
├── collector.ts                          # AST → FileIndex 的纯函数
├── fileIndexer.ts                        # path/text/blocks → FileIndex（带行偏移）
└── index.ts                              # 导出

shared/src/symbols.ts                     # SymbolEntry / ReferenceEntry 类型（从 server 移出，方便 client 共用）

tests/server/parser/hlsl/
├── parser.test.ts
├── collector.test.ts
├── fileIndexer.test.ts
└── fixtures/
    ├── functions.hlsl
    ├── structs.hlsl
    ├── cbuffer.hlsl
    ├── overloads.hlsl
    ├── locals-and-params.hlsl
    ├── shadowing-loop.hlsl
    ├── multi-pass.shader               # 已存在于 Plan 02，引用即可
    └── nested-struct.hlsl

scripts/
└── fetch-tree-sitter-hlsl.mjs            # 下载/编译 WASM 的辅助脚本
```

修改：
- `server/package.json` — 加 `web-tree-sitter` 依赖
- `shared/src/protocol.ts` — re-export `./symbols`
- `tsconfig` 路径无需改

**职责拆分**：`parser.ts` 不感知"什么是符号"；`collector.ts` 不感知"文件类型"；`fileIndexer.ts` 不感知"如何走 AST"。

---

## Task 1: shared 类型 — SymbolEntry / ReferenceEntry

**Files:**
- Create: `shared/src/symbols.ts`
- Modify: `shared/src/protocol.ts`

- [ ] **Step 1: 写 `shared/src/symbols.ts`**

```typescript
export type SymbolKind =
  | 'function'
  | 'variable'
  | 'parameter'
  | 'localVariable'
  | 'struct'
  | 'structMember'
  | 'macro'
  | 'cbuffer';

export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  location: { uri: string; range: Range };
  scope?: string;
  parentType?: string;
  scopeRange?: Range;
  declaredType?: string;
}

export interface FunctionParameter {
  name: string;
  type: string;
  range: Range;
}

export interface FunctionSymbolEntry extends SymbolEntry {
  kind: 'function';
  returnType: string;
  parameters: FunctionParameter[];
}

export type ReferenceContext = 'call' | 'type' | 'member' | 'pragma' | 'identifier';

export interface ReferenceEntry {
  name: string;
  location: { uri: string; range: Range };
  context: ReferenceContext;
}

export interface FileIndex {
  uri: string;
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
}
```

- [ ] **Step 2: 修改 `shared/src/protocol.ts`**

```typescript
export const EXTENSION_ID = 'unity-shader-nav';
export const SERVER_NAME = 'UnityShaderNav Language Server';
export * from './symbols';
```

- [ ] **Step 3: build 通过**

```bash
npm run build -w @unity-shader-nav/shared
```

- [ ] **Step 4: Commit**

```bash
git add shared/src
git commit -m "feat(plan-03): shared SymbolEntry / FileIndex types"
```

---

## Task 2: 拉取 tree-sitter-hlsl WASM

**Files:**
- Create: `scripts/fetch-tree-sitter-hlsl.mjs`
- Create: `server/grammars/.gitkeep`
- Modify: `unity-shader-nav/package.json`（加 `postinstall` 钩子可选）
- Modify: `.gitignore`（如果 wasm 不入库，加 `server/grammars/*.wasm`）

- [ ] **Step 1: 决策记录**

我们把 WASM 入库。理由：tree-sitter-hlsl 上游不稳定发布 WASM artifact，每次构建从源码 emcc 太慢；入库可固定一个版本，CI 不依赖网络。

- [ ] **Step 2: 写 `scripts/fetch-tree-sitter-hlsl.mjs`**——一次性下载脚本

```javascript
// 用法：node scripts/fetch-tree-sitter-hlsl.mjs
// 从 tree-sitter-grammars/tree-sitter-hlsl release 拉 WASM。
// 实际版本以执行时为准；本脚本只用于 bootstrap。
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const URL = 'https://github.com/tree-sitter-grammars/tree-sitter-hlsl/releases/latest/download/tree-sitter-hlsl.wasm';

const res = await fetch(URL);
if (!res.ok) throw new Error(`fetch failed ${res.status}`);
await mkdir('server/grammars', { recursive: true });
writeFileSync('server/grammars/tree-sitter-hlsl.wasm', Buffer.from(await res.arrayBuffer()));
console.log('downloaded tree-sitter-hlsl.wasm');
```

- [ ] **Step 3: 执行脚本**

```bash
node scripts/fetch-tree-sitter-hlsl.mjs
```

预期：`server/grammars/tree-sitter-hlsl.wasm` 存在，大小 > 200KB。

> 若上游无 release artifact，则退化方案：克隆 `tree-sitter-grammars/tree-sitter-hlsl` 并 `npx tree-sitter build -w`。记录到 README。

- [ ] **Step 4: 让 wasm 入库**

```bash
git add -f server/grammars/tree-sitter-hlsl.wasm
```

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-tree-sitter-hlsl.mjs server/grammars
git commit -m "chore(plan-03): vendor tree-sitter-hlsl.wasm"
```

---

## Task 3: parser 适配层

**Files:**
- Create: `server/src/parser/hlsl/parser.ts`
- Modify: `server/package.json`（加 `web-tree-sitter`）
- Create: `tests/server/parser/hlsl/parser.test.ts`

- [ ] **Step 1: 装依赖**

```bash
npm install -w @unity-shader-nav/server web-tree-sitter@^0.22.0
```

- [ ] **Step 2: 写失败测试 `parser.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseHlsl } from '../../../../server/src/parser/hlsl/parser';

describe('parseHlsl', () => {
  it('parses a trivial function and returns a Tree with non-null rootNode', async () => {
    const tree = await parseHlsl('float foo(float a) { return a; }');
    expect(tree.rootNode).toBeDefined();
    expect(tree.rootNode.hasError).toBe(false);
  });

  it('produces error nodes for invalid HLSL but does not throw', async () => {
    const tree = await parseHlsl('float foo( {');
    expect(tree.rootNode.hasError).toBe(true);
  });
});
```

- [ ] **Step 3: 跑挂**

- [ ] **Step 4: 写 `parser.ts`**

```typescript
import { join } from 'node:path';
import Parser from 'web-tree-sitter';

let initPromise: Promise<void> | undefined;
let language: Parser.Language | undefined;

async function ensureReady(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init();
      const wasm = join(__dirname, '..', '..', '..', 'grammars', 'tree-sitter-hlsl.wasm');
      language = await Parser.Language.load(wasm);
    })();
  }
  await initPromise;
}

export async function parseHlsl(text: string): Promise<Parser.Tree> {
  await ensureReady();
  const parser = new Parser();
  parser.setLanguage(language!);
  return parser.parse(text);
}

export async function getLanguage(): Promise<Parser.Language> {
  await ensureReady();
  return language!;
}
```

- [ ] **Step 5: 跑测试**

```bash
npm run build -w @unity-shader-nav/server
npx vitest run tests/server/parser/hlsl/parser.test.ts
```

预期：PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/parser/hlsl/parser.ts tests/server/parser/hlsl/parser.test.ts server/package.json
git commit -m "feat(plan-03): web-tree-sitter HLSL parser singleton"
```

---

## Task 4: node helpers

**Files:**
- Create: `server/src/parser/hlsl/nodeHelpers.ts`

- [ ] **Step 1: 写 helpers（无单测，下游用即覆盖）**

```typescript
import type Parser from 'web-tree-sitter';
import type { Range } from '@unity-shader-nav/shared';

export function rangeOf(node: Parser.SyntaxNode): Range {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end:   { line: node.endPosition.row,   character: node.endPosition.column   },
  };
}

export function textOf(node: Parser.SyntaxNode | null | undefined): string {
  return node?.text ?? '';
}

export function* walk(root: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    yield n;
    for (let i = n.childCount - 1; i >= 0; i--) stack.push(n.child(i)!);
  }
}

export function firstChildOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === type) return c;
  }
  return undefined;
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/parser/hlsl/nodeHelpers.ts
git commit -m "feat(plan-03): tree-sitter node helpers"
```

---

## Task 5: collector — 全局函数

**Files:**
- Create: `tests/server/parser/hlsl/fixtures/functions.hlsl`
- Create: `tests/server/parser/hlsl/collector.test.ts`
- Create: `server/src/parser/hlsl/collector.ts`

- [ ] **Step 1: 写 `functions.hlsl` fixture**

```hlsl
float4 add(float4 a, float4 b) { return a + b; }
void   noReturn() { }
float3 mul3(float3 v, float k) { return v * k; }
```

- [ ] **Step 2: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHlsl } from '../../../../server/src/parser/hlsl/parser';
import { collect } from '../../../../server/src/parser/hlsl/collector';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');

describe('collector: functions', () => {
  it('collects all top-level function declarations', async () => {
    const text = fixture('functions.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///test/functions.hlsl', 0);

    const fns = result.symbols.filter((s) => s.kind === 'function');
    expect(fns.map((f) => f.name).sort()).toEqual(['add', 'mul3', 'noReturn']);

    const add = fns.find((f) => f.name === 'add')!;
    expect(add.declaredType).toBeUndefined();
    expect((add as any).returnType).toBe('float4');
    expect((add as any).parameters.map((p: any) => p.name)).toEqual(['a', 'b']);
    expect((add as any).parameters.map((p: any) => p.type)).toEqual(['float4', 'float4']);
  });
});
```

- [ ] **Step 3: 跑挂**

- [ ] **Step 4: 写 collector 的"函数"部分**

```typescript
import type Parser from 'web-tree-sitter';
import type {
  FileIndex,
  FunctionSymbolEntry,
  ReferenceEntry,
  SymbolEntry,
} from '@unity-shader-nav/shared';
import { rangeOf, textOf, walk, firstChildOfType } from './nodeHelpers';

interface CollectorState {
  uri: string;
  /** Line offset to apply to all ranges (used when collecting HLSL block inside .shader). */
  lineOffset: number;
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
}

function offsetRange<T extends { start: { line: number }; end: { line: number } }>(
  r: T,
  delta: number,
): T {
  if (delta === 0) return r;
  return {
    ...r,
    start: { ...r.start, line: r.start.line + delta },
    end:   { ...r.end,   line: r.end.line   + delta },
  };
}

function collectFunction(node: Parser.SyntaxNode, st: CollectorState): void {
  // tree-sitter-hlsl node types (subject to grammar version; verify in fixtures):
  //   function_definition / function_declaration
  //   - type_identifier or primitive_type: return type
  //   - identifier (the function name)
  //   - parameter_list
  const nameNode = node.childForFieldName('declarator')?.descendantsOfType('identifier')[0]
    ?? node.descendantsOfType('identifier').find((n) => n.parent === node || n.parent?.type === 'function_declarator');
  if (!nameNode) return;

  const typeNode = node.childForFieldName('type') ?? node.namedChild(0);
  const paramListNode =
    node.descendantsOfType('parameter_list')[0] ??
    node.descendantsOfType('parameters')[0];

  const parameters = (paramListNode?.namedChildren ?? [])
    .filter((c) => c.type === 'parameter_declaration' || c.type === 'parameter')
    .map((p) => {
      const pTypeNode = p.childForFieldName('type') ?? p.namedChild(0);
      const pNameNode = p.descendantsOfType('identifier').slice(-1)[0];
      return {
        name: textOf(pNameNode),
        type: textOf(pTypeNode),
        range: offsetRange(rangeOf(pNameNode ?? p), st.lineOffset),
      };
    });

  const entry: FunctionSymbolEntry = {
    name: textOf(nameNode),
    kind: 'function',
    location: { uri: st.uri, range: offsetRange(rangeOf(nameNode), st.lineOffset) },
    declaredType: undefined,
    scopeRange: undefined,
    returnType: textOf(typeNode),
    parameters,
  };
  st.symbols.push(entry);

  // also register parameters as 'parameter' symbols, scoped to this function
  const bodyNode = node.descendantsOfType('compound_statement')[0]
    ?? node.descendantsOfType('field_declaration_list')[0];
  const scopeRange = bodyNode ? offsetRange(rangeOf(bodyNode), st.lineOffset) : undefined;
  for (const p of parameters) {
    st.symbols.push({
      name: p.name,
      kind: 'parameter',
      location: { uri: st.uri, range: p.range },
      scope: entry.name,
      scopeRange,
      declaredType: p.type,
    });
  }
}

export function collect(
  root: Parser.SyntaxNode,
  _text: string,
  uri: string,
  lineOffset: number,
): FileIndex {
  const st: CollectorState = { uri, lineOffset, symbols: [], references: [] };

  for (const node of walk(root)) {
    if (node.type === 'function_definition' || node.type === 'function_declaration') {
      collectFunction(node, st);
    }
  }

  return { uri, symbols: st.symbols, references: st.references };
}
```

> 注：tree-sitter-hlsl grammar 的精确 node 类型名要以**实际 wasm 内部**为准。Task 5 完成后若测试挂，先用 `tree.rootNode.toString()` 打印结构，再调整 node type / field name 名字（这是预期的迭代）。

- [ ] **Step 5: 跑测试 + 必要的迭代调整**

```bash
npm run build -w @unity-shader-nav/server
npx vitest run tests/server/parser/hlsl/collector.test.ts
```

PASS 之前可能需要 1-2 轮微调（节点类型名）。

- [ ] **Step 6: Commit**

```bash
git add server/src/parser/hlsl/collector.ts tests/server/parser/hlsl/{fixtures/functions.hlsl,collector.test.ts}
git commit -m "feat(plan-03): collect HLSL function symbols + parameters"
```

---

## Task 6: collector — struct / cbuffer

**Files:**
- Create: `tests/server/parser/hlsl/fixtures/structs.hlsl`
- Create: `tests/server/parser/hlsl/fixtures/cbuffer.hlsl`
- Modify: `tests/server/parser/hlsl/collector.test.ts`
- Modify: `server/src/parser/hlsl/collector.ts`

- [ ] **Step 1: fixture `structs.hlsl`**

```hlsl
struct Attributes
{
    float4 positionOS : POSITION;
    float3 normalOS   : NORMAL;
    float2 uv         : TEXCOORD0;
};

struct Varyings { float4 positionCS : SV_Position; float2 uv : TEXCOORD0; };
```

- [ ] **Step 2: fixture `cbuffer.hlsl`**

```hlsl
cbuffer UnityPerMaterial
{
    float4 _MainTex_ST;
    float4 _Color;
    float  _Roughness;
};
```

- [ ] **Step 3: 追加测试**

```typescript
describe('collector: struct', () => {
  it('collects struct name and its members with parentType + declaredType', async () => {
    const text = fixture('structs.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///test/structs.hlsl', 0);

    const structs = result.symbols.filter((s) => s.kind === 'struct').map((s) => s.name);
    expect(structs.sort()).toEqual(['Attributes', 'Varyings']);

    const members = result.symbols.filter((s) => s.kind === 'structMember');
    const attMembers = members.filter((m) => m.parentType === 'Attributes');
    expect(attMembers.map((m) => m.name).sort()).toEqual(['normalOS', 'positionOS', 'uv']);
    expect(attMembers.find((m) => m.name === 'positionOS')!.declaredType).toBe('float4');
  });
});

describe('collector: cbuffer', () => {
  it('collects cbuffer as both cbuffer and its globals', async () => {
    const text = fixture('cbuffer.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///test/cbuffer.hlsl', 0);

    const cbufs = result.symbols.filter((s) => s.kind === 'cbuffer').map((s) => s.name);
    expect(cbufs).toEqual(['UnityPerMaterial']);

    const vars = result.symbols.filter((s) => s.kind === 'variable').map((v) => v.name);
    expect(vars.sort()).toEqual(['_Color', '_MainTex_ST', '_Roughness']);
  });
});
```

- [ ] **Step 4: 扩展 collector**

在 `collect()` 的 walk 循环里加分支：

```typescript
if (node.type === 'struct_specifier' || node.type === 'struct_declaration') {
  collectStruct(node, st);
} else if (node.type === 'cbuffer_declaration' || node.type === 'constant_buffer_declaration') {
  collectCbuffer(node, st);
}
```

实现：

```typescript
function collectStruct(node: Parser.SyntaxNode, st: CollectorState): void {
  const nameNode = node.descendantsOfType('type_identifier')[0]
    ?? node.descendantsOfType('identifier')[0];
  if (!nameNode) return;
  const structName = textOf(nameNode);

  st.symbols.push({
    name: structName,
    kind: 'struct',
    location: { uri: st.uri, range: offsetRange(rangeOf(nameNode), st.lineOffset) },
  });

  const body = node.descendantsOfType('field_declaration_list')[0]
    ?? node.descendantsOfType('struct_declaration_list')[0];
  if (!body) return;

  for (const field of body.namedChildren) {
    if (field.type !== 'field_declaration' && field.type !== 'declaration') continue;
    const typeNode = field.childForFieldName('type') ?? field.namedChild(0);
    for (const id of field.descendantsOfType('field_identifier')
      .concat(field.descendantsOfType('identifier'))) {
      if (id === typeNode) continue;
      st.symbols.push({
        name: textOf(id),
        kind: 'structMember',
        parentType: structName,
        declaredType: textOf(typeNode),
        location: { uri: st.uri, range: offsetRange(rangeOf(id), st.lineOffset) },
      });
    }
  }
}

function collectCbuffer(node: Parser.SyntaxNode, st: CollectorState): void {
  const nameNode = node.descendantsOfType('identifier')[0];
  if (nameNode) {
    st.symbols.push({
      name: textOf(nameNode),
      kind: 'cbuffer',
      location: { uri: st.uri, range: offsetRange(rangeOf(nameNode), st.lineOffset) },
    });
  }

  const body = node.descendantsOfType('field_declaration_list')[0];
  if (!body) return;

  for (const field of body.namedChildren) {
    if (field.type !== 'field_declaration' && field.type !== 'declaration') continue;
    const typeNode = field.childForFieldName('type') ?? field.namedChild(0);
    for (const id of field.descendantsOfType('identifier')) {
      if (id === typeNode) continue;
      st.symbols.push({
        name: textOf(id),
        kind: 'variable',
        declaredType: textOf(typeNode),
        location: { uri: st.uri, range: offsetRange(rangeOf(id), st.lineOffset) },
      });
    }
  }
}
```

- [ ] **Step 5: 跑测试 + 迭代**

```bash
npx vitest run tests/server/parser/hlsl/collector.test.ts
```

PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/parser/hlsl/collector.ts tests/server/parser/hlsl/{fixtures,collector.test.ts}
git commit -m "feat(plan-03): collect struct + cbuffer + members"
```

---

## Task 7: collector — 局部变量 + proximity tie-break 元数据

**Files:**
- Create: `tests/server/parser/hlsl/fixtures/locals-and-params.hlsl`
- Create: `tests/server/parser/hlsl/fixtures/shadowing-loop.hlsl`
- Modify: `collector.test.ts`、`collector.ts`

- [ ] **Step 1: fixture `locals-and-params.hlsl`**

```hlsl
float4 compute(float4 input, float k)
{
    float scale = k * 2.0;
    float4 result = input * scale;
    return result;
}
```

- [ ] **Step 2: fixture `shadowing-loop.hlsl`**

```hlsl
void f()
{
    for (int i = 0; i < 10; ++i) { }
    for (int i = 0; i < 5;  ++i) { }   // 同名 shadowing → 两个 SymbolEntry
}
```

- [ ] **Step 3: 测试**

```typescript
describe('collector: locals & params', () => {
  it('collects locals with scope = function name and scopeRange spanning body', async () => {
    const text = fixture('locals-and-params.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/loc.hlsl', 0);

    const locals = result.symbols.filter((s) => s.kind === 'localVariable');
    expect(locals.map((l) => l.name).sort()).toEqual(['result', 'scale']);
    expect(locals.every((l) => l.scope === 'compute')).toBe(true);
    expect(locals[0].scopeRange).toBeDefined();
  });
});

describe('collector: shadowing', () => {
  it('keeps both i declarations as separate SymbolEntry', async () => {
    const text = fixture('shadowing-loop.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/shadow.hlsl', 0);

    const is = result.symbols.filter((s) => s.kind === 'localVariable' && s.name === 'i');
    expect(is).toHaveLength(2);
    expect(is[0].location.range.start.line).toBeLessThan(is[1].location.range.start.line);
  });
});
```

- [ ] **Step 4: 扩展 collector**

在 `collectFunction` 里增加 locals 抓取（在 body 子树里 walk 找 `declaration` / `variable_declaration` / `for_statement` 内的 init declarator）。

```typescript
function collectLocals(
  fnName: string,
  bodyNode: Parser.SyntaxNode,
  scopeRange: any,
  st: CollectorState,
): void {
  for (const n of walk(bodyNode)) {
    if (n.type !== 'declaration' && n.type !== 'init_declaration' &&
        n.type !== 'local_variable_declaration') continue;
    const typeNode = n.childForFieldName('type') ?? n.namedChild(0);
    for (const id of n.descendantsOfType('identifier')) {
      if (id === typeNode) continue;
      // crude: only direct decl identifiers, not initializer expressions
      if (id.parent !== n && id.parent?.type !== 'init_declarator' &&
          id.parent?.type !== 'variable_declarator') continue;
      st.symbols.push({
        name: textOf(id),
        kind: 'localVariable',
        location: { uri: st.uri, range: offsetRange(rangeOf(id), st.lineOffset) },
        scope: fnName,
        scopeRange,
        declaredType: textOf(typeNode),
      });
    }
  }
}
```

并在 `collectFunction` 里调用：

```typescript
if (bodyNode) collectLocals(textOf(nameNode), bodyNode, scopeRange, st);
```

- [ ] **Step 5: 跑测试，迭代**

实际 tree-sitter 节点名要看 grammar；如果不命中，先打印 `bodyNode.toString()` 调整。

- [ ] **Step 6: Commit**

```bash
git add server/src/parser/hlsl/collector.ts tests/server/parser/hlsl/{fixtures,collector.test.ts}
git commit -m "feat(plan-03): collect local variables with scope metadata"
```

---

## Task 8: collector — 引用（call / type / member / identifier）

**Files:**
- Modify: `collector.ts`、`collector.test.ts`

- [ ] **Step 1: 测试**

```typescript
describe('collector: references', () => {
  it('records function calls as references with context=call', async () => {
    const text = `
      float4 add(float4 a, float4 b) { return a + b; }
      float4 main() { return add(float4(0,0,0,1), float4(1,1,1,1)); }
    `;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/refs.hlsl', 0);

    const refs = result.references.filter((r) => r.name === 'add');
    expect(refs).toHaveLength(1);
    expect(refs[0].context).toBe('call');
  });

  it('records member accesses with context=member', async () => {
    const text = `void f(Varyings v) { float2 x = v.uv; }`;
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/m.hlsl', 0);
    const uv = result.references.filter((r) => r.name === 'uv' && r.context === 'member');
    expect(uv).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 扩展 collector**

在 `walk` 循环中：

```typescript
if (node.type === 'call_expression') {
  const callee = node.childForFieldName('function') ?? node.namedChild(0);
  if (callee && (callee.type === 'identifier' || callee.type === 'field_expression')) {
    const nameNode = callee.type === 'identifier' ? callee : callee.descendantsOfType('field_identifier').slice(-1)[0];
    if (nameNode) {
      st.references.push({
        name: textOf(nameNode),
        location: { uri: st.uri, range: offsetRange(rangeOf(nameNode), st.lineOffset) },
        context: 'call',
      });
    }
  }
} else if (node.type === 'field_expression') {
  const fid = node.childForFieldName('field') ?? node.descendantsOfType('field_identifier').slice(-1)[0];
  if (fid) {
    st.references.push({
      name: textOf(fid),
      location: { uri: st.uri, range: offsetRange(rangeOf(fid), st.lineOffset) },
      context: 'member',
    });
  }
} else if (node.type === 'type_identifier') {
  st.references.push({
    name: textOf(node),
    location: { uri: st.uri, range: offsetRange(rangeOf(node), st.lineOffset) },
    context: 'type',
  });
}
```

注意：不要重复登记 `function_definition` 自己声明位置上的标识符——加一个 set 排除已经作为 symbol 注册的 range，或者在 walk 进入 `function_definition`/`struct_specifier` 时 skip 其 declarator 部分。最小实现允许"声明点也算 reference"，但下游 LSP 会排除它（plan 13 处理）。

- [ ] **Step 3: 跑测试**

- [ ] **Step 4: Commit**

```bash
git add server/src/parser/hlsl/collector.ts tests/server/parser/hlsl/collector.test.ts
git commit -m "feat(plan-03): collect call/member/type references"
```

---

## Task 9: fileIndexer — 处理 `.shader` 多 HLSL 块拼接

**Files:**
- Create: `server/src/parser/hlsl/fileIndexer.ts`
- Create: `tests/server/parser/hlsl/fileIndexer.test.ts`

- [ ] **Step 1: 写测试**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexFile } from '../../../../server/src/parser/hlsl/fileIndexer';

describe('fileIndexer: pure .hlsl', () => {
  it('treats whole file as one HLSL block', async () => {
    const text = `float4 add(float4 a, float4 b) { return a + b; }`;
    const idx = await indexFile('file:///t/x.hlsl', text);
    expect(idx.symbols.find((s) => s.name === 'add')).toBeDefined();
  });
});

describe('fileIndexer: .shader multi-pass', () => {
  it('flattens symbols from all HLSL blocks into one file index', async () => {
    const text = readFileSync(
      join(__dirname, '../shaderlab/fixtures/multi-pass.shader'),
      'utf8',
    );
    const idx = await indexFile('file:///t/x.shader', text);
    const verts = idx.symbols.filter((s) => s.kind === 'function' && s.name === 'vert');
    // multi-pass fixture has 2 `void vert() {}` definitions
    expect(verts).toHaveLength(2);
    // 行号必须落在原 .shader 文件的对应行（不应该是 0/1，应该是 HLSLPROGRAM 后一两行）
    expect(verts[0].location.range.start.line).toBeGreaterThan(3);
    expect(verts[1].location.range.start.line).toBeGreaterThan(verts[0].location.range.start.line);
  });
});
```

- [ ] **Step 2: 实现 `fileIndexer.ts`**

```typescript
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileIndex } from '@unity-shader-nav/shared';
import { parseHlsl } from './parser';
import { collect } from './collector';
import { scanBlocks } from '../shaderlab/blockScanner';

const HLSL_EXTS = new Set(['.hlsl', '.cginc', '.hlslinc', '.compute']);

function extOf(uri: string): string {
  try {
    return extname(fileURLToPath(uri)).toLowerCase();
  } catch {
    return extname(uri).toLowerCase();
  }
}

export async function indexFile(uri: string, text: string): Promise<FileIndex> {
  const ext = extOf(uri);
  if (HLSL_EXTS.has(ext)) {
    const tree = await parseHlsl(text);
    return collect(tree.rootNode, text, uri, 0);
  }

  if (ext === '.shader') {
    const { blocks } = scanBlocks(text);
    const lines = text.split(/\r?\n/);

    const merged: FileIndex = { uri, symbols: [], references: [] };
    for (const block of blocks) {
      const blockText = lines
        .slice(block.contentStartLine, block.contentEndLine + 1)
        .join('\n');
      const tree = await parseHlsl(blockText);
      const part = collect(tree.rootNode, blockText, uri, block.contentStartLine);
      merged.symbols.push(...part.symbols);
      merged.references.push(...part.references);
    }
    return merged;
  }

  return { uri, symbols: [], references: [] };
}
```

- [ ] **Step 3: 跑测试**

```bash
npm run build -w @unity-shader-nav/server
npx vitest run tests/server/parser/hlsl/fileIndexer.test.ts
```

预期：PASS。

- [ ] **Step 4: 写 `server/src/parser/hlsl/index.ts`**

```typescript
export { parseHlsl } from './parser';
export { collect } from './collector';
export { indexFile } from './fileIndexer';
```

- [ ] **Step 5: Commit**

```bash
git add server/src/parser/hlsl/{fileIndexer.ts,index.ts} tests/server/parser/hlsl/fileIndexer.test.ts
git commit -m "feat(plan-03): file indexer flattening .shader blocks"
```

---

## Task 10: 嵌套 struct fixture（chain lookup 元数据已就绪验证）

**Files:**
- Create: `tests/server/parser/hlsl/fixtures/nested-struct.hlsl`
- Modify: `collector.test.ts`

- [ ] **Step 1: fixture**

```hlsl
struct Inner { float3 normal; };
struct Outer { Inner inner; float4 position; };

Outer Make() { Outer o; return o; }
```

- [ ] **Step 2: 测试**

```typescript
describe('collector: nested struct metadata', () => {
  it('records Outer.inner as structMember with declaredType=Inner', async () => {
    const text = fixture('nested-struct.hlsl');
    const tree = await parseHlsl(text);
    const result = collect(tree.rootNode, text, 'file:///t/n.hlsl', 0);

    const innerMember = result.symbols.find(
      (s) => s.kind === 'structMember' && s.parentType === 'Outer' && s.name === 'inner',
    );
    expect(innerMember).toBeDefined();
    expect(innerMember!.declaredType).toBe('Inner');

    const makeFn = result.symbols.find((s) => s.kind === 'function' && s.name === 'Make') as any;
    expect(makeFn.returnType).toBe('Outer');
  });
});
```

- [ ] **Step 3: 跑测试。如果挂，可能需要细调 collector 对 `Inner` 这种非内置类型的处理（type_identifier vs identifier）**

- [ ] **Step 4: Commit**

```bash
git add tests/server/parser/hlsl/{fixtures,collector.test.ts}
git commit -m "test(plan-03): nested struct metadata for L2 chain lookup"
```

---

## Acceptance

1. ✅ `npm test -w @unity-shader-nav/server` 全过；测试覆盖：函数、struct、cbuffer、参数、局部变量、shadowing、引用、`.shader` 拼接、嵌套 struct
2. ✅ `FileIndex` 字段完整（含 `declaredType`、`returnType`、`parameters`），为 chain lookup（Plan 11）提供原始数据
3. ✅ `server/grammars/tree-sitter-hlsl.wasm` 入库
4. ✅ `.shader` 多块测试中，符号行号正确映射回**原文件**坐标（不是块内坐标）

对应 Spec §5（符号表设计）、§7（ShaderLab 解析）；为 Spec §10 Case 1/8 提供数据底座。

## Manual Verification

```bash
cat > /tmp/dump-index.mjs <<'EOF'
import { indexFile } from './server/out/parser/hlsl/index.js';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const text = readFileSync(path, 'utf8');
const uri = `file://${path}`;
const idx = await indexFile(uri, text);
console.log('SYMBOLS', JSON.stringify(idx.symbols, null, 2));
console.log('REFS COUNT', idx.references.length);
EOF

node /tmp/dump-index.mjs tests/server/parser/hlsl/fixtures/structs.hlsl
node /tmp/dump-index.mjs tests/server/parser/shaderlab/fixtures/multi-pass.shader
```

预期：能看到带 `kind`/`name`/`location` 的符号数组；多 Pass 文件里 `vert` 出现两次，行号是 .shader 原文件坐标。

完成后进入 Plan 04。
