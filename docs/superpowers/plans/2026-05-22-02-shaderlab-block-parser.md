# Plan 02: ShaderLab Block Parser 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个**纯函数**：输入 `.shader` 文件文本，输出该文件内所有 HLSL 代码块的精确范围（开始行、结束行、块类型）。本计划不涉及 LSP、不接 tree-sitter；只产出一个 100% 单测覆盖的 ShaderLab 行级状态机，供 Plan 03 的 HLSL 收集器调用。

**Architecture:** 行级状态机，两个状态：`SHADERLAB` 和 `HLSL_BLOCK`。逐行扫描，遇到 `HLSLPROGRAM` / `CGPROGRAM` / `HLSLINCLUDE` / `CGINCLUDE` 进入 HLSL 块；遇到 `ENDHLSL` / `ENDCG` 退出。识别忽略行内前后空白；忽略整行注释（`//`、`/* */`）和字符串内的关键字（粗判，spec §7 容忍）。同时顺手提取顶层结构（Shader/SubShader/Pass）供 Plan 10 的 Document Symbols 复用。

**Tech Stack:** 纯 TypeScript，无运行时依赖。测试用 `vitest`。Node API 仅用 `fs`（读 fixture）。

**Dependencies:** Plan 01。

---

## File Structure

新建：

```
shared/src/
└── structure.ts              # ShaderLabBlock / ShaderLabStructureNode 跨进程共享类型

unity-shader-nav/server/src/parser/
├── shaderlab/
│   ├── blockScanner.ts        # 状态机核心：行 → token → 状态转移
│   ├── structureScanner.ts    # Shader/SubShader/Pass 顶层结构识别
│   └── index.ts               # 公开 API 出口（types 从 shared 取）
└── (parser/ 目录在本计划首次创建)

unity-shader-nav/tests/server/parser/shaderlab/
├── blockScanner.test.ts
├── structureScanner.test.ts
└── fixtures/
    ├── single-pass.shader
    ├── multi-pass.shader
    ├── hlslinclude-with-passes.shader
    ├── cg-legacy.shader
    ├── mixed-comments.shader
    ├── nested-braces.shader
    └── unterminated-block.shader
```

修改：无源码外文件。

**职责拆分**：`blockScanner` 只管 HLSL 块边界；`structureScanner` 只管 Shader/SubShader/Pass 嵌套。它们各自独立扫描同一份文本，输出互不依赖——故障域清晰，便于单测。

---

## Task 1: 类型定义（放在 shared）

ShaderLab 结构需要在多个进程间共享（Plan 10 的 `FileIndex.structure` 会序列化到客户端 / 缓存），所以本计划起把类型放到 `shared/src/structure.ts`，Plan 10 直接复用，**不要**再造 `ShaderLabStructureLite` 变体。

**Files:**
- Create: `shared/src/structure.ts`
- Modify: `shared/src/protocol.ts`（追加 `export * from './structure';`）

- [ ] **Step 1: 写类型文件**

```typescript
// shared/src/structure.ts
export type BlockKind = 'HLSLPROGRAM' | 'CGPROGRAM' | 'HLSLINCLUDE' | 'CGINCLUDE';

export interface ShaderLabBlock {
  kind: BlockKind;
  /** Line on which the HLSLPROGRAM/CGPROGRAM directive appears (0-based). */
  startLine: number;
  /** Line on which the ENDHLSL/ENDCG directive appears (0-based). Inclusive. */
  endLine: number;
  /** Line range of HLSL CONTENT (exclusive of directives): startLine+1 .. endLine-1. */
  contentStartLine: number;
  contentEndLine: number;
  /** True if the matching ENDHLSL/ENDCG was never found before EOF. */
  unterminated: boolean;
}

export type ShaderLabNodeKind = 'shader' | 'subshader' | 'pass';

export interface ShaderLabStructureNode {
  kind: ShaderLabNodeKind;
  /** Shader "Name" → "Name"; Pass { Name "X" } → "X"; else undefined. */
  name?: string;
  /** Range of the opening directive line (0-based). */
  headerLine: number;
  /** Closing brace line (0-based); equals headerLine if not found. */
  closeLine: number;
  children: ShaderLabStructureNode[];
}

export interface ScanResult {
  blocks: ShaderLabBlock[];
}

export interface StructureResult {
  /** Top-level shader nodes; usually exactly one. */
  shaders: ShaderLabStructureNode[];
}
```

- [ ] **Step 2: 在 `shared/src/protocol.ts` 追加 re-export**

```typescript
export * from './structure';
```

- [ ] **Step 3: build 通过**

```bash
npm run build -w @unity-shader-nav/shared
```

预期：无错误。

- [ ] **Step 4: Commit**

```bash
git add shared/src/structure.ts shared/src/protocol.ts
git commit -m "feat(plan-02): shaderlab parser types in shared"
```

---

## Task 2: 单 Pass fixture + 最小 blockScanner

**Files:**
- Create: `tests/server/parser/shaderlab/fixtures/single-pass.shader`
- Create: `tests/server/parser/shaderlab/blockScanner.test.ts`
- Create: `server/src/parser/shaderlab/blockScanner.ts`
- Create: `server/src/parser/shaderlab/index.ts`

- [ ] **Step 1: 写 fixture `single-pass.shader`**

```hlsl
Shader "Test/Single" {
  SubShader {
    Pass {
      HLSLPROGRAM
      #pragma vertex vert
      float4 vert() : SV_Position { return float4(0,0,0,1); }
      ENDHLSL
    }
  }
}
```

记录关键行号：
- 第 3 行（0-based: 3）`HLSLPROGRAM` → startLine=3
- 第 6 行（0-based: 6）`ENDHLSL` → endLine=6
- 内容范围 contentStartLine=4, contentEndLine=5

- [ ] **Step 2: 写失败测试 `blockScanner.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanBlocks } from '../../../../server/src/parser/shaderlab/blockScanner';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('scanBlocks: single-pass', () => {
  it('finds exactly one HLSLPROGRAM block', () => {
    const text = fixture('single-pass.shader');
    const result = scanBlocks(text);

    expect(result.blocks).toHaveLength(1);
    const [b] = result.blocks;
    expect(b.kind).toBe('HLSLPROGRAM');
    expect(b.startLine).toBe(3);
    expect(b.endLine).toBe(6);
    expect(b.contentStartLine).toBe(4);
    expect(b.contentEndLine).toBe(5);
    expect(b.unterminated).toBe(false);
  });
});
```

- [ ] **Step 3: 跑挂**

```bash
npx vitest run tests/server/parser/shaderlab/blockScanner.test.ts
```

预期：FAIL，找不到 `scanBlocks`。

- [ ] **Step 4: 写最小实现 `blockScanner.ts`**

```typescript
import type { BlockKind, ScanResult, ShaderLabBlock } from '@unity-shader-nav/shared';

const START_DIRECTIVES: Record<string, BlockKind> = {
  HLSLPROGRAM: 'HLSLPROGRAM',
  CGPROGRAM: 'CGPROGRAM',
  HLSLINCLUDE: 'HLSLINCLUDE',
  CGINCLUDE: 'CGINCLUDE',
};

const END_DIRECTIVES_FOR: Record<BlockKind, string> = {
  HLSLPROGRAM: 'ENDHLSL',
  CGPROGRAM: 'ENDCG',
  HLSLINCLUDE: 'ENDHLSL',
  CGINCLUDE: 'ENDCG',
};

function trimDirective(line: string): string {
  return line.replace(/\/\/.*$/, '').trim();
}

export function scanBlocks(text: string): ScanResult {
  const lines = text.split(/\r?\n/);
  const blocks: ShaderLabBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const trimmed = trimDirective(lines[i]);
    const startKind = START_DIRECTIVES[trimmed];
    if (!startKind) { i++; continue; }

    const startLine = i;
    const endDirective = END_DIRECTIVES_FOR[startKind];
    let endLine = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (trimDirective(lines[j]) === endDirective) {
        endLine = j;
        break;
      }
    }

    if (endLine === -1) {
      blocks.push({
        kind: startKind,
        startLine,
        endLine: lines.length - 1,
        contentStartLine: startLine + 1,
        contentEndLine: lines.length - 1,
        unterminated: true,
      });
      i = lines.length;
    } else {
      blocks.push({
        kind: startKind,
        startLine,
        endLine,
        contentStartLine: startLine + 1,
        contentEndLine: endLine - 1,
        unterminated: false,
      });
      i = endLine + 1;
    }
  }

  return { blocks };
}
```

- [ ] **Step 5: 写 `index.ts` 出口**

```typescript
export { scanBlocks } from './blockScanner';
```

> Types 不在此 re-export；调用方直接 `import { ShaderLabBlock } from '@unity-shader-nav/shared'`。

- [ ] **Step 6: 跑过**

```bash
npx vitest run tests/server/parser/shaderlab/blockScanner.test.ts
```

预期：PASS。

- [ ] **Step 7: Commit**

```bash
git add server/src/parser/shaderlab/{blockScanner,index}.ts tests/server/parser/shaderlab/{fixtures/single-pass.shader,blockScanner.test.ts}
git commit -m "feat(plan-02): block scanner minimal HLSLPROGRAM detection"
```

---

## Task 3: 多 Pass + HLSLINCLUDE

**Files:**
- Create: `tests/server/parser/shaderlab/fixtures/multi-pass.shader`
- Create: `tests/server/parser/shaderlab/fixtures/hlslinclude-with-passes.shader`
- Modify: `tests/server/parser/shaderlab/blockScanner.test.ts`

- [ ] **Step 1: 写 `multi-pass.shader`**

```hlsl
Shader "Test/MultiPass" {
  SubShader {
    Pass {
      Name "ForwardLit"
      HLSLPROGRAM
      void vert() {}
      ENDHLSL
    }
    Pass {
      Name "ShadowCaster"
      HLSLPROGRAM
      void vert() {}
      ENDHLSL
    }
  }
}
```

预期 2 个 HLSLPROGRAM 块。

- [ ] **Step 2: 写 `hlslinclude-with-passes.shader`**

```hlsl
Shader "Test/Inc" {
  HLSLINCLUDE
  float4 Shared(float4 x) { return x; }
  ENDHLSL

  SubShader {
    Pass {
      HLSLPROGRAM
      void main() {}
      ENDHLSL
    }
  }
}
```

预期：第 1 块为 HLSLINCLUDE，第 2 块为 HLSLPROGRAM；都不 unterminated。

- [ ] **Step 3: 追加测试用例**

```typescript
describe('scanBlocks: multi-pass', () => {
  it('finds 2 HLSLPROGRAM blocks', () => {
    const result = scanBlocks(fixture('multi-pass.shader'));
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].kind).toBe('HLSLPROGRAM');
    expect(result.blocks[1].kind).toBe('HLSLPROGRAM');
    expect(result.blocks[0].startLine).toBeLessThan(result.blocks[1].startLine);
  });
});

describe('scanBlocks: HLSLINCLUDE + Pass', () => {
  it('emits HLSLINCLUDE first then HLSLPROGRAM', () => {
    const result = scanBlocks(fixture('hlslinclude-with-passes.shader'));
    expect(result.blocks.map((b) => b.kind)).toEqual(['HLSLINCLUDE', 'HLSLPROGRAM']);
    expect(result.blocks.every((b) => !b.unterminated)).toBe(true);
  });
});
```

- [ ] **Step 4: 跑测试**

```bash
npx vitest run tests/server/parser/shaderlab/blockScanner.test.ts
```

预期：全部 PASS（Task 2 的实现已经支持多块）。如果挂，修 `scanBlocks`。

- [ ] **Step 5: Commit**

```bash
git add tests/server/parser/shaderlab/{fixtures,blockScanner.test.ts}
git commit -m "test(plan-02): multi-pass + HLSLINCLUDE fixtures"
```

---

## Task 4: CG 兼容 + 注释/字符串干扰

**Files:**
- Create: `tests/server/parser/shaderlab/fixtures/cg-legacy.shader`
- Create: `tests/server/parser/shaderlab/fixtures/mixed-comments.shader`
- Modify: `tests/server/parser/shaderlab/blockScanner.test.ts`
- Modify: `server/src/parser/shaderlab/blockScanner.ts`（如需）

- [ ] **Step 1: 写 `cg-legacy.shader`**

```hlsl
Shader "Legacy" {
  SubShader {
    Pass {
      CGPROGRAM
      sampler2D _MainTex;
      ENDCG
    }
  }
}
```

预期：1 个 CGPROGRAM 块，配 ENDCG 而非 ENDHLSL。

- [ ] **Step 2: 写 `mixed-comments.shader`**

```hlsl
Shader "Test/Comments" {
  // HLSLPROGRAM  ← 注释里假关键字
  SubShader {
    Pass {
      // following block is real
      HLSLPROGRAM
      // ENDHLSL  ← 注释里假关键字
      void f() {}
      ENDHLSL
    }
  }
}
```

预期：1 个 HLSLPROGRAM 块；位置正确，不被注释里假关键字误触发或误终止。

- [ ] **Step 3: 追加测试用例**

```typescript
describe('scanBlocks: CG legacy', () => {
  it('matches CGPROGRAM with ENDCG', () => {
    const result = scanBlocks(fixture('cg-legacy.shader'));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].kind).toBe('CGPROGRAM');
    expect(result.blocks[0].unterminated).toBe(false);
  });
});

describe('scanBlocks: comments do not trigger', () => {
  it('ignores HLSLPROGRAM/ENDHLSL inside line comments', () => {
    const result = scanBlocks(fixture('mixed-comments.shader'));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].unterminated).toBe(false);
  });
});
```

- [ ] **Step 4: 跑测试**

```bash
npx vitest run tests/server/parser/shaderlab/blockScanner.test.ts
```

`mixed-comments` 应该已经过（`trimDirective` 已经剥 `//`）。`cg-legacy` 也应该过。如果挂，调整实现。

- [ ] **Step 5: Commit**

```bash
git add tests/server/parser/shaderlab/{fixtures,blockScanner.test.ts}
git commit -m "test(plan-02): CG legacy + comment-disambiguation fixtures"
```

---

## Task 5: 嵌套大括号 + 未闭合块

**Files:**
- Create: `tests/server/parser/shaderlab/fixtures/nested-braces.shader`
- Create: `tests/server/parser/shaderlab/fixtures/unterminated-block.shader`
- Modify: `tests/server/parser/shaderlab/blockScanner.test.ts`

- [ ] **Step 1: 写 `nested-braces.shader`**（HLSL 里很多花括号，不能干扰）

```hlsl
Shader "Test/Nested" {
  SubShader {
    Pass {
      HLSLPROGRAM
      struct Foo { float a; struct Bar { float b; }; };
      void f() { { { } } }
      ENDHLSL
    }
  }
}
```

- [ ] **Step 2: 写 `unterminated-block.shader`**

```hlsl
Shader "Bad" {
  SubShader {
    Pass {
      HLSLPROGRAM
      // forgot ENDHLSL
      void vert() {}
    }
  }
}
```

预期：1 个块，`unterminated=true`，`endLine=lastLineIndex`。

- [ ] **Step 3: 追加测试**

```typescript
describe('scanBlocks: nested braces inside HLSL', () => {
  it('does not get confused by braces in HLSL body', () => {
    const result = scanBlocks(fixture('nested-braces.shader'));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].unterminated).toBe(false);
  });
});

describe('scanBlocks: unterminated block', () => {
  it('flags unterminated=true and extends endLine to EOF', () => {
    const text = fixture('unterminated-block.shader');
    const lines = text.split(/\r?\n/);
    const result = scanBlocks(text);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].unterminated).toBe(true);
    expect(result.blocks[0].endLine).toBe(lines.length - 1);
  });
});
```

- [ ] **Step 4: 跑测试**

```bash
npx vitest run tests/server/parser/shaderlab/blockScanner.test.ts
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add tests/server/parser/shaderlab/{fixtures,blockScanner.test.ts}
git commit -m "test(plan-02): nested braces + unterminated block"
```

---

## Task 6: structureScanner — Shader / SubShader / Pass 嵌套

**Files:**
- Create: `tests/server/parser/shaderlab/structureScanner.test.ts`
- Create: `server/src/parser/shaderlab/structureScanner.ts`
- Modify: `server/src/parser/shaderlab/index.ts`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanStructure } from '../../../../server/src/parser/shaderlab/structureScanner';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('scanStructure: single-pass', () => {
  it('returns Shader > SubShader > Pass tree with shader name', () => {
    const result = scanStructure(fixture('single-pass.shader'));
    expect(result.shaders).toHaveLength(1);
    const shader = result.shaders[0];
    expect(shader.kind).toBe('shader');
    expect(shader.name).toBe('Test/Single');
    expect(shader.children).toHaveLength(1);

    const subshader = shader.children[0];
    expect(subshader.kind).toBe('subshader');
    expect(subshader.children).toHaveLength(1);

    const pass = subshader.children[0];
    expect(pass.kind).toBe('pass');
  });
});

describe('scanStructure: multi-pass with names', () => {
  it('extracts Pass Name "X" tokens', () => {
    const result = scanStructure(fixture('multi-pass.shader'));
    const passes = result.shaders[0].children[0].children;
    expect(passes.map((p) => p.name)).toEqual(['ForwardLit', 'ShadowCaster']);
  });
});
```

- [ ] **Step 2: 跑挂**

```bash
npx vitest run tests/server/parser/shaderlab/structureScanner.test.ts
```

预期：FAIL。

- [ ] **Step 3: 写 `structureScanner.ts`**

```typescript
import type { StructureResult, ShaderLabStructureNode, ShaderLabNodeKind } from '@unity-shader-nav/shared';

const SHADER_RE   = /^\s*Shader\s+"([^"]*)"/;
const SUBSHADER_RE = /^\s*SubShader\b/;
const PASS_RE      = /^\s*Pass\b/;
const PASS_NAME_RE = /^\s*Name\s+"([^"]*)"/;

function stripComment(line: string): string {
  return line.replace(/\/\/.*$/, '');
}

interface Frame {
  node: ShaderLabStructureNode;
  braceDepth: number;
}

export function scanStructure(text: string): StructureResult {
  const lines = text.split(/\r?\n/);
  const shaders: ShaderLabStructureNode[] = [];
  const stack: Frame[] = [];

  function open(kind: ShaderLabNodeKind, line: number, name: string | undefined): void {
    const node: ShaderLabStructureNode = {
      kind, name, headerLine: line, closeLine: line, children: [],
    };
    if (stack.length === 0) {
      if (kind === 'shader') shaders.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, braceDepth: 0 });
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);

    const shaderMatch = SHADER_RE.exec(raw);
    if (shaderMatch && stack.length === 0) {
      open('shader', i, shaderMatch[1]);
    } else if (SUBSHADER_RE.test(raw) && stack.length > 0 && stack[stack.length - 1].node.kind === 'shader') {
      open('subshader', i, undefined);
    } else if (PASS_RE.test(raw) && stack.length > 0 && stack[stack.length - 1].node.kind === 'subshader') {
      open('pass', i, undefined);
    } else {
      const nameMatch = PASS_NAME_RE.exec(raw);
      if (nameMatch && stack.length > 0 && stack[stack.length - 1].node.kind === 'pass') {
        stack[stack.length - 1].node.name = nameMatch[1];
      }
    }

    for (const ch of raw) {
      if (ch === '{') {
        if (stack.length > 0) stack[stack.length - 1].braceDepth++;
      } else if (ch === '}') {
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          top.braceDepth--;
          if (top.braceDepth <= 0) {
            top.node.closeLine = i;
            stack.pop();
          }
        }
      }
    }
  }

  return { shaders };
}
```

- [ ] **Step 4: 更新 `index.ts`**

```typescript
export { scanBlocks } from './blockScanner';
export { scanStructure } from './structureScanner';
```

- [ ] **Step 5: 跑测试**

```bash
npx vitest run tests/server/parser/shaderlab/structureScanner.test.ts
```

预期：PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/parser/shaderlab/{structureScanner.ts,index.ts} tests/server/parser/shaderlab/structureScanner.test.ts
git commit -m "feat(plan-02): scan ShaderLab Shader/SubShader/Pass tree"
```

---

## Task 7: 与块扫描器交叉验证

**Files:**
- Modify: `tests/server/parser/shaderlab/blockScanner.test.ts`

- [ ] **Step 1: 追加一组组合测试**——确保 blockScanner 输出和 structureScanner 不冲突

```typescript
import { scanStructure } from '../../../../server/src/parser/shaderlab/structureScanner';

describe('scan integration: blocks fall inside their owning Pass', () => {
  it('every HLSLPROGRAM block sits inside some Pass node', () => {
    const text = fixture('multi-pass.shader');
    const blocks = scanBlocks(text).blocks;
    const structure = scanStructure(text);
    const passes = structure.shaders[0].children[0].children;

    for (const block of blocks) {
      const owner = passes.find(
        (p) => p.headerLine <= block.startLine && block.endLine <= p.closeLine,
      );
      expect(owner, `block at line ${block.startLine} should be inside a Pass`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: 跑测试**

```bash
npx vitest run tests/server/parser/shaderlab/blockScanner.test.ts
```

预期：PASS。如果挂，多半是 structureScanner 的花括号深度算错；修。

- [ ] **Step 3: Commit**

```bash
git add tests/server/parser/shaderlab/blockScanner.test.ts
git commit -m "test(plan-02): cross-check blocks belong to Pass nodes"
```

---

## Task 8: 性能验证（防回归）

**Files:**
- Create: `tests/server/parser/shaderlab/blockScanner.perf.test.ts`

- [ ] **Step 1: 写性能 smoke**

```typescript
import { describe, it, expect } from 'vitest';
import { scanBlocks } from '../../../../server/src/parser/shaderlab/blockScanner';

describe('blockScanner perf smoke', () => {
  it('scans 10000-line synthetic shader in < 50ms', () => {
    const body = Array.from({ length: 1000 }, () =>
      [
        '    Pass {',
        '      HLSLPROGRAM',
        '      void f() {}',
        '      ENDHLSL',
        '    }',
      ].join('\n'),
    ).join('\n');
    const text = `Shader "Big" {\n  SubShader {\n${body}\n  }\n}`;

    const t0 = performance.now();
    const result = scanBlocks(text);
    const dt = performance.now() - t0;

    expect(result.blocks.length).toBe(1000);
    expect(dt).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: 跑测试**

```bash
npx vitest run tests/server/parser/shaderlab/blockScanner.perf.test.ts
```

预期：PASS。若挂，可调阈值（dev 机性能差异允许 50-100ms）。

- [ ] **Step 3: Commit**

```bash
git add tests/server/parser/shaderlab/blockScanner.perf.test.ts
git commit -m "test(plan-02): perf smoke for blockScanner"
```

---

## Acceptance

1. ✅ `npm test -w @unity-shader-nav/server` 全部通过；至少 7 个测试 case
2. ✅ 所有 fixture 文件均存在
3. ✅ `server/src/parser/shaderlab/index.ts` 导出 `scanBlocks`、`scanStructure`；类型从 `@unity-shader-nav/shared` 导出
4. ✅ 性能 smoke：1000 个 HLSL 块文本扫描 < 50ms

对应 Spec §10：无直接 acceptance case（基础设施层）；但 Plan 04 / Plan 10 会依赖本计划输出。

## Manual Verification

写一段最小 driver 脚本验证：

```bash
cat > /tmp/verify-plan02.mjs <<'EOF'
import { scanBlocks, scanStructure } from './server/out/parser/shaderlab/index.js';
import { readFileSync } from 'node:fs';

const text = readFileSync(process.argv[2], 'utf8');
console.log('blocks:', scanBlocks(text));
console.log('structure:', JSON.stringify(scanStructure(text), null, 2));
EOF

node /tmp/verify-plan02.mjs tests/server/parser/shaderlab/fixtures/multi-pass.shader
```

预期：终端打出 2 个 block 和一棵 shader → subshader → 2× pass 的结构树，每个 pass 各带名字。

完成后进入 Plan 03。
