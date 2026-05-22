# Plan 12: Macro Definitions 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收集 `#define MACRO_NAME ...` 并把它登记为 `SymbolKind = 'macro'`；F12 在宏使用点跳到 define 处。Spec §10 Case 11。

**Architecture:**
- 在 fileIndexer 里加一个 `scanDefines(blockText, lineOffset, uri)`，行级正则识别 `^\s*#\s*define\s+(IDENT)`，登记到 `FileIndex.symbols` 作为 `kind: 'macro'`。
- 不需要扩展 resolver，因为现有 `resolveDefinition` 直接按 name 查找，`macro` 符号自然进入候选；多文件多 `#define` 同名（常见，如 `#define _SHADOWS_ENABLED`）走 multi-candidate Peek（ADR-0001）。
- 引用端：tree-sitter-hlsl 把宏调用解析为 `call_expression` 或 `preproc_*`。在 collector 中加一条规则：当 call_expression 的 callee 是大写全局 identifier，且未匹配 declaration macro 时，仍登记为 `'call'` 引用——这部分 Plan 03 已经覆盖。F12 时 `resolveDefinition` 自动命中 `macro` 符号。

**Tech Stack:** 既有。

**Dependencies:** Plan 01-07。

---

## File Structure

新建：
```
server/src/parser/preproc/
├── scanDefines.ts
└── scanDefines.test.ts 入 tests/

tests/server/parser/preproc/
├── scanDefines.test.ts
└── fixtures/
    └── defines.hlsl
tests/integration/client/
└── macro-definitions.test.ts
```

修改：
- `server/src/parser/hlsl/fileIndexer.ts` — 在每块文本上扫 `scanDefines`
- 可选：`server/src/macros/builtin.ts` 没影响

---

## Task 1: scanDefines

**Files:**
- Create: `server/src/parser/preproc/scanDefines.ts`
- Create: `tests/server/parser/preproc/scanDefines.test.ts`
- Create: `tests/server/parser/preproc/fixtures/defines.hlsl`

- [ ] **Step 1: fixture**

```hlsl
#define MAX_LIGHTS 4
#define SAMPLE_TEXTURE2D(tex, sampler, uv) tex.Sample(sampler, uv)
#define EMPTY
// #define COMMENTED_OUT
#define   PRESSED_MULTI_SPACES   42
```

- [ ] **Step 2: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanDefines } from '../../../../server/src/parser/preproc/scanDefines';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');

describe('scanDefines', () => {
  it('captures simple #define names with line/range', () => {
    const text = fixture('defines.hlsl');
    const out = scanDefines(text);
    expect(out.map((d) => d.name).sort()).toEqual([
      'EMPTY', 'MAX_LIGHTS', 'PRESSED_MULTI_SPACES', 'SAMPLE_TEXTURE2D',
    ]);
    const max = out.find((d) => d.name === 'MAX_LIGHTS')!;
    expect(max.line).toBe(0);
    const lineText = text.split('\n')[0];
    expect(lineText.slice(max.nameRange.start.character, max.nameRange.end.character)).toBe('MAX_LIGHTS');
  });

  it('ignores commented-out defines', () => {
    const text = fixture('defines.hlsl');
    const out = scanDefines(text);
    expect(out.find((d) => d.name === 'COMMENTED_OUT')).toBeUndefined();
  });
});
```

- [ ] **Step 3: 实现**

```typescript
import type { Range } from '@unity-shader-nav/shared';

export interface DefineDirective {
  name: string;
  line: number;
  nameRange: Range;
}

const DEFINE_RE = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/;

export function scanDefines(text: string): DefineDirective[] {
  const lines = text.split(/\r?\n/);
  const out: DefineDirective[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.replace(/\/\/.*$/, '');
    const m = DEFINE_RE.exec(code);
    if (!m) continue;
    const name = m[1];
    const nameStart = code.indexOf(name, code.indexOf('define'));
    out.push({
      name,
      line: i,
      nameRange: {
        start: { line: i, character: nameStart },
        end:   { line: i, character: nameStart + name.length },
      },
    });
  }
  return out;
}
```

- [ ] **Step 4: 跑测 + Commit**

```bash
npx vitest run tests/server/parser/preproc/scanDefines.test.ts
git add server/src/parser/preproc/scanDefines.ts tests/server/parser/preproc
git commit -m "feat(plan-12): scan #define directives"
```

---

## Task 2: fileIndexer 集成

**Files:**
- Modify: `server/src/parser/hlsl/fileIndexer.ts`
- Modify: `tests/server/parser/hlsl/fileIndexer.test.ts`

- [ ] **Step 1: 在 `.shader` 每个块后、`.hlsl` 全文 collect 后，scan defines 并 push 为 `kind: 'macro'`**

```typescript
import { scanDefines } from '../preproc/scanDefines';

function pushDefines(blockText: string, lineOffset: number, uri: string, dest: SymbolEntry[]): void {
  const defs = scanDefines(blockText);
  for (const d of defs) {
    dest.push({
      name: d.name,
      kind: 'macro',
      location: {
        uri,
        range: {
          start: { line: d.nameRange.start.line + lineOffset, character: d.nameRange.start.character },
          end:   { line: d.nameRange.end.line   + lineOffset, character: d.nameRange.end.character   },
        },
      },
    });
  }
}
```

- [ ] **Step 2: 单测**

```typescript
it('records #define as macro symbol', async () => {
  const text = '#define FOO 1\nfloat4 main(){return 0;}';
  const idx = await indexFile('file:///t/d.hlsl', text);
  const foo = idx.symbols.find((s) => s.name === 'FOO');
  expect(foo?.kind).toBe('macro');
});
```

- [ ] **Step 3: 跑测 + Commit**

```bash
git add server/src/parser/hlsl/fileIndexer.ts tests/server/parser/hlsl/fileIndexer.test.ts
git commit -m "feat(plan-12): index #define as macro symbols"
```

---

## Task 3: 集成测

**Files:**
- Create: `tests/integration/client/fixtures/macros-define/Macros.hlsl`
- Create: `tests/integration/client/fixtures/macros-define/Use.hlsl`
- Create: `tests/integration/client/macro-definitions.test.ts`

- [ ] **Step 1: fixtures**

`Macros.hlsl`:
```hlsl
#define SAMPLE_TEXTURE2D(t, s, uv) t.Sample(s, uv)
#define MAX_LIGHTS 4
```

`Use.hlsl`:
```hlsl
#include "Macros.hlsl"
float4 frag() {
    return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, float2(0, 0));
}
```

- [ ] **Step 2: 测试**

```typescript
suite('Macro definitions', () => {
  test('F12 on SAMPLE_TEXTURE2D jumps to #define', async () => {
    const fp = path.resolve(__dirname, 'fixtures/macros-define/Use.hlsl');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 1500));

    const line = doc.getText().split('\n').findIndex((l) => l.includes('SAMPLE_TEXTURE2D('));
    const col = doc.lineAt(line).text.indexOf('SAMPLE_TEXTURE2D') + 4;
    const pos = new vscode.Position(line, col);

    const links = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', uri, pos,
    );
    assert.ok(links && links.length >= 1);
    const target: vscode.Uri = links[0].targetUri ?? links[0].uri;
    assert.ok(target.fsPath.endsWith('Macros.hlsl'));
  });
});
```

- [ ] **Step 3: Commit**

```bash
npm test
git add tests/integration/client
git commit -m "test(plan-12): F12 on macro use jumps to #define"
```

---

## Acceptance

1. ✅ 单测：scanDefines + fileIndexer 命中 `#define`
2. ✅ Spec §10 **Case 11**：F12 在 `SAMPLE_TEXTURE2D(...)` 调用上 → 跳到 `#define SAMPLE_TEXTURE2D` 处
3. ✅ 同名宏在多个 #ifdef 分支 / 多文件中各定义一次时，走多候选 Peek
4. ✅ 宏体内的内容**不展开**——F12 跳到 `#define` 行后停止（ADR-0003 明确约定）

## Manual Verification

1. F5 → 打开 fixture
2. F12 on `SAMPLE_TEXTURE2D(...)` 的 `SAMPLE_TEXTURE2D` → 跳到 `Macros.hlsl` 第 0 行
3. 修改 `Use.hlsl` 加 `int n = MAX_LIGHTS;`，F12 on `MAX_LIGHTS` → 跳到 `Macros.hlsl` 第 1 行

完成后进入 Plan 13。
