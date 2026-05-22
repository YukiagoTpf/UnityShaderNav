# Plan 02 Fix 实施计划

> **For agentic workers:** 不是新功能 plan，是对 Plan 02 已落地代码的修订。基于 `docs/superpowers/plans/plan02review.md` 的 4 个 finding（2 P1 + 2 P2）。每个 Task 修一个问题，commit 单独提交。

**Goal:** 让 `scanBlocks` / `scanStructure` 在字符串、`/* */` 块注释和行内 Pass Name 场景下也产出正确结果，并把 Plan 10 即将依赖的 `headerLine` / `closeLine` 范围用显式断言锁住。

**Architecture 变更点：**
- 新增 `sanitizeLine(text)` 助手 —— 单一函数同时处理 `//`、`/* */`（同行）、字符串字面量内容，作为两个 scanner 的共同前处理层。两个 P1（字符串括号）和 P2#1（指令行块注释）共享根因，应当用同一个 sanitizer 修，而不是分别打补丁。
- `structureScanner` 在打开 Pass 之后扫描同一行剩余字符以提取 `Name "X"`，覆盖 `Pass { Name "X" }` 紧凑写法。
- `structureScanner.test` 新增 headerLine / closeLine 显式断言 + 4 个新 fixture。

**与 Plan 01 / plan01fix 的协调约束（不要破坏）：**
- 测试文件落在 `server/tests/parser/shaderlab/`，**不是** `tests/server/`。plan01fix Task 4 已经把 layout 迁过去；新加的 fixture 和 spec 都跟着走 `server/tests/...`。
- 类型仍在 `shared/src/structure.ts`，被 `@unity-shader-nav/shared` re-export。任何对 `ShaderLabStructureNode` 的字段调整都改 shared，不在 server 本地造新 types。
- 不动 monorepo workspaces 顺序、build chain、esbuild 输出位置、`copy-server.mjs`、publisher 字段。

**Dependencies:** Plan 01 + plan01fix + Plan 02。

---

## File Structure 变更

```
unity-shader-nav/
├── server/
│   ├── src/parser/shaderlab/
│   │   ├── sanitize.ts                # [新增] 共享文本前处理
│   │   ├── blockScanner.ts            # 改 trimDirective 接 sanitize
│   │   └── structureScanner.ts        # 改 brace loop + inline Pass Name
│   └── tests/parser/shaderlab/
│       ├── sanitize.test.ts           # [新增] sanitizer 单测
│       ├── structureScanner.test.ts   # 加 headerLine/closeLine + 边界 case
│       ├── blockScanner.test.ts       # 加 directive 行内块注释 case
│       └── fixtures/
│           ├── strings-with-braces.shader     # [新增]
│           ├── directive-block-comment.shader # [新增]
│           ├── inline-pass-name.shader        # [新增]
│           ├── multi-subshader.shader         # [新增]
│           └── (原有 7 个 fixture 保持)
```

---

## Task 1: 引入 `sanitizeLine` 共享前处理

**问题（根因）**：`blockScanner.trimDirective` 只剥 `//` 行注释。`structureScanner.stripComment` 同样。两者都没考虑 `/* */` 和字符串字面量内容。直接修每个 scanner 会重复逻辑也容易出现行为不一致；提一个共享 sanitizer 更稳。

**Files:**
- Create: `unity-shader-nav/server/src/parser/shaderlab/sanitize.ts`
- Create: `unity-shader-nav/server/tests/parser/shaderlab/sanitize.test.ts`

- [ ] **Step 1: 写 sanitizer**

设计：单趟扫描，状态机 4 态：`code` / `lineComment` / `blockComment` / `string`。输出与输入等长（用空格替换被屏蔽字符），这样列号在下游仍然有效。

**字符串内屏蔽策略**：只屏蔽**结构性字符** `{` `}`（让 brace 计数看不见 `"}"` 这种字面量），其他字符保留 —— 这样 `SHADER_RE = /^\s*Shader\s+"([^"]*)"/` 之类的正则在 sanitize 之后仍能从字符串里捕获 shader/pass 名字。两个 P1 / P2#1 需要的下游消费模式（regex 取 name + brace 计数）共用同一份 sanitized 输出，不需要双 pass。

跨行 `/* */`：MVP 不跨行 —— 每行独立调 sanitize，块注释只在同行内被识别。这与 review 的"otherwise document"匹配。

```typescript
// server/src/parser/shaderlab/sanitize.ts
const enum S { Code, Line, Block, Str }

export function sanitizeLine(line: string): string {
  let state: S = S.Code;
  const out: string[] = new Array(line.length);
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    switch (state) {
      case S.Code:
        if (ch === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = S.Line; break; }
        if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i++; state = S.Block; break; }
        if (ch === '"') { out[i] = ch; state = S.Str; break; }
        out[i] = ch;
        break;
      case S.Line:
        out[i] = ' ';
        break;
      case S.Block:
        if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = S.Code; break; }
        out[i] = ' ';
        break;
      case S.Str:
        if (ch === '"') { out[i] = ch; state = S.Code; break; }
        if (ch === '\\' && next !== undefined) { out[i] = ch; out[i + 1] = next; i++; break; }
        out[i] = (ch === '{' || ch === '}') ? ' ' : ch;
        break;
    }
  }
  return out.join('');
}
```

- [ ] **Step 2: 单测**

```typescript
// server/tests/parser/shaderlab/sanitize.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeLine } from '../../../src/parser/shaderlab/sanitize';

describe('sanitizeLine', () => {
  it('passes through plain code unchanged', () => {
    expect(sanitizeLine('Pass {')).toBe('Pass {');
  });

  it('masks // line comments to spaces', () => {
    const out = sanitizeLine('Pass { // HLSLPROGRAM here');
    expect(out).toHaveLength('Pass { // HLSLPROGRAM here'.length);
    expect(out.slice(0, 7)).toBe('Pass { ');
    expect(out.slice(7)).toBe(' '.repeat('// HLSLPROGRAM here'.length));
  });

  it('masks /* */ same-line block comments', () => {
    const out = sanitizeLine('HLSLPROGRAM /* trailing */');
    expect(out).toHaveLength('HLSLPROGRAM /* trailing */'.length);
    expect(out.slice(0, 11)).toBe('HLSLPROGRAM');
    expect(out.slice(11).trim()).toBe('');
  });

  it('handles multiple block comments on one line', () => {
    const out = sanitizeLine('Pass /*a*/ { /*b*/ }');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('Pass { }');
  });

  it('masks string contents (preserves quotes)', () => {
    const out = sanitizeLine('Shader "Test/X" { Pass { } }');
    expect(out.includes('Test/X')).toBe(false);
    expect(out.includes('"')).toBe(true);
    // Braces inside strings would be masked — verify with explicit case:
    const tricky = sanitizeLine('const s = "}";');
    expect(tricky.includes('}')).toBe(false);
  });

  it('does not carry block-comment state across lines (MVP limitation)', () => {
    // Single-line sanitize: an opening /* without closing */ leaves the rest
    // of the line masked, but the next line is processed fresh as Code.
    const out = sanitizeLine('/* unterminated');
    expect(out).toBe(' '.repeat(out.length));
    const next = sanitizeLine('still code */');
    // The next line starts in Code state — the `*/` is literal here. Calling
    // code that needs multiline awareness must implement its own state.
    expect(next.includes('still code')).toBe(true);
  });

  it('handles escaped quotes inside strings', () => {
    const out = sanitizeLine('"a\\"b" Pass');
    expect(out.endsWith(' Pass')).toBe(true);
    expect(out.includes('a')).toBe(false);
  });
});
```

- [ ] **Step 3: build + 测**

```bash
cd unity-shader-nav
npm run build -w @unity-shader-nav/server
cd server && npx vitest run tests/parser/shaderlab/sanitize.test.ts
```

预期：PASS。

- [ ] **Step 4: Commit**

```bash
git add unity-shader-nav/server/src/parser/shaderlab/sanitize.ts unity-shader-nav/server/tests/parser/shaderlab/sanitize.test.ts
git commit -m "feat(plan-02-fix): sanitizeLine helper for comment/string masking"
```

---

## Task 2: P1#1 — `scanStructure` 不再被字符串里的括号干扰

**问题**：`scanStructure` 在 brace 循环里直接 `for (const ch of raw)`，把字符串里的 `}` 也算作 ShaderLab 结构括号。复现：

```hlsl
Shader "X" {
  SubShader {
    Pass {
      HLSLPROGRAM
      const char* s = "}";
      ENDHLSL
    }
  }
}
```

当前结果 pass.closeLine=4（错），正确应是 6。

**Files:**
- Modify: `unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts`
- Create: `unity-shader-nav/server/tests/parser/shaderlab/fixtures/strings-with-braces.shader`
- Modify: `unity-shader-nav/server/tests/parser/shaderlab/structureScanner.test.ts`

- [ ] **Step 1: fixture**

```hlsl
Shader "X" {
  SubShader {
    Pass {
      HLSLPROGRAM
      const char* s = "}";
      ENDHLSL
    }
  }
}
```

- [ ] **Step 2: 失败断言**

```typescript
// 追加到 structureScanner.test.ts
describe('scanStructure: braces inside strings (P1#1)', () => {
  it('does not close pass/subshader/shader on `"}"` literal', () => {
    const result = scanStructure(fixture('strings-with-braces.shader'));
    expect(result.shaders).toHaveLength(1);
    const shader = result.shaders[0];
    const subshader = shader.children[0];
    const pass = subshader.children[0];

    // Without sanitization, pass.closeLine was 4 (the `"}"` line); fixed value:
    expect(pass.closeLine).toBe(6);     // line with the real `}` of Pass
    expect(subshader.closeLine).toBe(7);// SubShader's `}`
    expect(shader.closeLine).toBe(8);   // Shader's `}`
  });
});
```

跑测试预期 FAIL。

- [ ] **Step 3: 实现 —— 接 sanitizer**

```typescript
// structureScanner.ts
import { sanitizeLine } from './sanitize';

// remove the old stripComment helper
// replace `const raw = stripComment(lines[i]);` with:
const raw = sanitizeLine(lines[i]);
```

跑测试预期 PASS。

- [ ] **Step 4: Commit**

```bash
git add unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts unity-shader-nav/server/tests/parser/shaderlab/structureScanner.test.ts unity-shader-nav/server/tests/parser/shaderlab/fixtures/strings-with-braces.shader
git commit -m "fix(plan-02): scanStructure ignores braces in strings"
```

---

## Task 3: P2#1 — `scanBlocks` 接受指令行尾的 `/* */`

**问题**：`HLSLPROGRAM /* trailing */` 这种写法 `trimDirective` 只剥 `//` 不剥 `/* */`，导致整行不匹配任何 START_DIRECTIVES，块边界识别失败。

**Files:**
- Modify: `unity-shader-nav/server/src/parser/shaderlab/blockScanner.ts`
- Create: `unity-shader-nav/server/tests/parser/shaderlab/fixtures/directive-block-comment.shader`
- Modify: `unity-shader-nav/server/tests/parser/shaderlab/blockScanner.test.ts`

- [ ] **Step 1: fixture**

```hlsl
Shader "X" {
  SubShader {
    Pass {
      HLSLPROGRAM /* real block with trailing comment */
      void f() {}
      ENDHLSL /* done */
    }
  }
}
```

- [ ] **Step 2: 失败断言**

```typescript
describe('scanBlocks: directive with same-line block comment (P2#1)', () => {
  it('recognizes HLSLPROGRAM and ENDHLSL when followed by /* */', () => {
    const result = scanBlocks(fixture('directive-block-comment.shader'));
    expect(result.blocks).toHaveLength(1);
    const [b] = result.blocks;
    expect(b.kind).toBe('HLSLPROGRAM');
    expect(b.unterminated).toBe(false);
    expect(b.startLine).toBe(3);
    expect(b.endLine).toBe(5);
  });
});
```

- [ ] **Step 3: 实现 —— `trimDirective` 用 sanitizer**

```typescript
// blockScanner.ts
import { sanitizeLine } from './sanitize';

function trimDirective(line: string): string {
  return sanitizeLine(line).trim();
}
```

老的 `replace(/\/\/.*$/, '').trim()` 替换掉。

- [ ] **Step 4: 跑测**

跑 blockScanner.test 应仍全过（注释剥离逻辑被 sanitizer 一并覆盖，旧测试也应该不被破坏）。

- [ ] **Step 5: Commit**

```bash
git add unity-shader-nav/server/src/parser/shaderlab/blockScanner.ts unity-shader-nav/server/tests/parser/shaderlab/blockScanner.test.ts unity-shader-nav/server/tests/parser/shaderlab/fixtures/directive-block-comment.shader
git commit -m "fix(plan-02): scanBlocks accepts /* */ on directive lines"
```

---

## Task 4: P1#2 — 行内 `Pass { Name "X" }` 也填 `ShaderLabStructureNode.name`

**问题**：现在 `PASS_RE` 命中后只在 `else` 分支里查 `PASS_NAME_RE`，意思是 Name 必须独占一行。`Pass { Name "Inline" }` 这种紧凑写法导致 pass.name 为 undefined。

**Files:**
- Modify: `unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts`
- Create: `unity-shader-nav/server/tests/parser/shaderlab/fixtures/inline-pass-name.shader`
- Modify: `unity-shader-nav/server/tests/parser/shaderlab/structureScanner.test.ts`

- [ ] **Step 1: fixture**

```hlsl
Shader "X" {
  SubShader {
    Pass { Name "Inline" }
    Pass {
      Name "Multiline"
    }
  }
}
```

- [ ] **Step 2: 失败断言**

```typescript
describe('scanStructure: inline Pass { Name "X" } (P1#2)', () => {
  it('extracts name from same line as Pass {', () => {
    const result = scanStructure(fixture('inline-pass-name.shader'));
    const passes = result.shaders[0].children[0].children;
    expect(passes).toHaveLength(2);
    expect(passes[0].name).toBe('Inline');
    expect(passes[1].name).toBe('Multiline');
  });
});
```

- [ ] **Step 3: 实现**

`structureScanner.ts` 中 `PASS_RE.test(raw)` 命中打开 pass 后，立刻在**同一行**剩余部分再找 `Name "..."`：

```typescript
} else if (PASS_RE.test(raw) && stack.length > 0 && stack[stack.length - 1].node.kind === 'subshader') {
  open('pass', i, undefined);
  // Also scan the rest of the line for inline `Name "..."` (e.g. `Pass { Name "X" }`).
  const inlineName = /\bName\s+"([^"]*)"/.exec(raw);
  if (inlineName) {
    stack[stack.length - 1].node.name = inlineName[1];
  }
} else {
  // ... existing else branch ...
}
```

注意：`raw` 此时已经 sanitize 过（Task 2 改的），所以字符串内的伪 Name 不会误触。

- [ ] **Step 4: 跑测**

预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add unity-shader-nav/server/src/parser/shaderlab/structureScanner.ts unity-shader-nav/server/tests/parser/shaderlab/structureScanner.test.ts unity-shader-nav/server/tests/parser/shaderlab/fixtures/inline-pass-name.shader
git commit -m "fix(plan-02): scanStructure extracts inline Pass Name"
```

---

## Task 5: P2#2 — 加强 structureScanner 范围 / 边界覆盖

**问题**：现有两个 case 只校验 tree shape 和 next-line Pass name，没断言 `headerLine` / `closeLine`、没覆盖多 SubShader、没覆盖块注释 / 未闭合括号。Plan 10 依赖这些范围做 outline，回归风险隐藏。

**Files:**
- Create: `unity-shader-nav/server/tests/parser/shaderlab/fixtures/multi-subshader.shader`
- Modify: `unity-shader-nav/server/tests/parser/shaderlab/structureScanner.test.ts`

- [ ] **Step 1: multi-subshader fixture**

```hlsl
Shader "MultiSS" {
  SubShader {
    Tags { "RenderPipeline" = "URP" }
    Pass {
      HLSLPROGRAM
      void v() {}
      ENDHLSL
    }
  }
  SubShader {
    Pass {
      HLSLPROGRAM
      void v2() {}
      ENDHLSL
    }
  }
}
```

- [ ] **Step 2: 加 4 个新 case 到 structureScanner.test.ts**

```typescript
describe('scanStructure: explicit ranges (P2#2)', () => {
  it('records headerLine and closeLine for single-pass shader', () => {
    const result = scanStructure(fixture('single-pass.shader'));
    const shader = result.shaders[0];
    expect(shader.headerLine).toBe(0);
    expect(shader.closeLine).toBe(8);
    const subshader = shader.children[0];
    expect(subshader.headerLine).toBe(1);
    expect(subshader.closeLine).toBe(7);
    const pass = subshader.children[0];
    expect(pass.headerLine).toBe(2);
    expect(pass.closeLine).toBe(6);
  });

  it('returns multiple SubShader siblings', () => {
    const result = scanStructure(fixture('multi-subshader.shader'));
    const subs = result.shaders[0].children;
    expect(subs).toHaveLength(2);
    expect(subs[0].kind).toBe('subshader');
    expect(subs[1].kind).toBe('subshader');
    // each SubShader has exactly one Pass
    expect(subs[0].children).toHaveLength(1);
    expect(subs[1].children).toHaveLength(1);
  });

  it('flags unterminated braces by leaving closeLine at EOF', () => {
    // Reuse Plan 02's unterminated-block.shader: the Shader's `}` exists
    // but Pass's body is open (HLSLPROGRAM never closed). scanStructure
    // only counts braces, so its behavior on this fixture is well-defined:
    // shader closes at its own `}`, Pass closes whenever brace depth returns
    // to zero (here at the line after ENDHLSL block, since `Pass {` opened
    // depth 1 and depth returns when reaching the matching `}` line).
    const result = scanStructure(fixture('unterminated-block.shader'));
    const shader = result.shaders[0];
    expect(shader.closeLine).toBeGreaterThan(shader.headerLine);
  });

  it('ignores ShaderLab-style block comments around tokens', () => {
    // Embed /* ... */ between SubShader and Pass to confirm sanitization
    // also covers the structure side.
    const text = `Shader "X" {
  SubShader {
    /* between */
    Pass {
    }
  }
}`;
    const result = scanStructure(text);
    const pass = result.shaders[0].children[0].children[0];
    expect(pass.kind).toBe('pass');
    expect(pass.headerLine).toBe(3);
  });
});
```

- [ ] **Step 3: 跑测**

```bash
cd unity-shader-nav/server && npx vitest run tests/parser/shaderlab/structureScanner.test.ts
```

预期新增 4 case PASS，total structureScanner test 数 = 原 2 + Task 2 加 1 + Task 4 加 1 + Task 5 加 4 = 8。

- [ ] **Step 4: Commit**

```bash
git add unity-shader-nav/server/tests/parser/shaderlab/structureScanner.test.ts unity-shader-nav/server/tests/parser/shaderlab/fixtures/multi-subshader.shader
git commit -m "test(plan-02): explicit range assertions and edge cases for scanStructure"
```

---

## Acceptance

1. ✅ `npm run build` 全 workspace 零错
2. ✅ `npm test` 全过：
   - vitest：sanitize 7 + handshake 1 + blockScanner 8+1 (Task 3) + structureScanner 2+1+1+4 (Tasks 2/4/5) + perf 1 = **24 case**（原 12 + 12 新）
   - mocha：仍 2/2（plan01fix 已建立）
3. ✅ 4 个 review finding 都有 fixture + 失败断言改 PASS
4. ✅ 与 plan01fix 拓扑零冲突：测试在 `server/tests/`、类型在 `shared/src/`、build chain 不变

## Manual Verification

跑 plan 02 原 perf smoke 看 sanitizer 是否拖慢 —— 1000 块 < 50ms 预算应该仍宽裕（sanitize 是 O(n) 单趟）。如果 < 5ms → 没问题。如果 > 30ms → 性能 regression，回头看。

完成后 PROGRESS.md 加 plan02fix 章节，标 Plan 02 状态为 "Done + plan02fix applied"。
