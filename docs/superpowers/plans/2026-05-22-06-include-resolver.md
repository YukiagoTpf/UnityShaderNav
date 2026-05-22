# Plan 06: Include Resolver 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Spec §6 的 include 路径解析器：把 `#include "..."` 字符串解析到磁盘上的绝对路径；支持 F12 在 include 路径上**直接打开目标文件**（Spec §10 Case 4）。本计划只处理"相对路径 + projectRoot/Assets + 用户配置 includeDirectories + 环形/大小写"四种情况；Packages 虚拟路径留给 Plan 07。

**Architecture:**
- `IncludeResolver`：纯函数 `resolve(includeText, fromFileUri, ctx) → ResolvedInclude | null`；`ctx` 含 `projectRoot`、`includeDirectories`、`packageResolver?`（本计划暂不接，留接口）。
- `IncludeReferenceCollector`：扫每个 HLSL 块文本，按行抓 `#include "..."` 并把字符串区间登记为 `ReferenceEntry`（`context: 'identifier'` 复用，但 `name` 字段存原始字符串）。
- LSP `textDocument/definition` 增加分支：当 `wordAt` 返回 null（光标在字符串字面量内）时，尝试解析当前行的 include 指令。

**Tech Stack:** Node `fs/promises` + `path`；纯逻辑、可单测。

**Dependencies:** Plan 01-05。

---

## File Structure

新建：
```
server/src/include/
├── types.ts                # ResolvedInclude, IncludeContext
├── resolver.ts             # 主体 resolve()
├── circularGuard.ts        # 路径遍历去重（仅在 Plan 08 增量索引时用，提前预留）
└── index.ts

server/src/parser/include/
├── lineScanner.ts          # 从文本中提取 #include 行的位置 + 路径字符串
└── lineScanner.test.ts 入 tests/

tests/server/include/
├── resolver.test.ts
├── lineScanner.test.ts
└── fixtures/
    ├── projectA/
    │   ├── Assets/
    │   │   ├── Shaders/
    │   │   │   ├── Main.shader
    │   │   │   ├── Common.hlsl
    │   │   │   └── Inner/Lighting.hlsl
    │   │   └── CustomCG/MyHelper.hlsl
    │   ├── ProjectSettings/.gitkeep
    │   └── Packages/.gitkeep
    └── caseSensitivity/
        ├── Assets/
        │   └── Shaders/
        │       ├── Main.hlsl
        │       └── helper.hlsl   # 实际全小写

tests/integration/client/
└── include-jump.test.ts
```

修改：
- `server/src/handlers/definition.ts` — 加 include 字符串分支
- `server/src/parser/hlsl/fileIndexer.ts` — 调 `lineScanner` 把 include 也作为 reference 入库（供 Find References 和 Plan 08 增量更新使用）

---

## Task 1: lineScanner — 从文本扫描 `#include` 行

**Files:**
- Create: `server/src/parser/include/lineScanner.ts`
- Create: `tests/server/parser/include/lineScanner.test.ts`

- [ ] **Step 1: 类型 + 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { scanIncludes } from '../../../../server/src/parser/include/lineScanner';

describe('scanIncludes', () => {
  it('extracts #include directives with quoted path and range', () => {
    const text = [
      '// banner',
      '#include "Common.hlsl"',
      '  #include   "Inner/Lighting.hlsl"',
      'float4 main() { return 0; }',
    ].join('\n');
    const result = scanIncludes(text);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('Common.hlsl');
    expect(result[0].pathRange.start.line).toBe(1);
    // pathRange spans only the inside of the quotes
    const lineText = text.split('\n')[1];
    expect(lineText.slice(result[0].pathRange.start.character, result[0].pathRange.end.character)).toBe('Common.hlsl');
  });

  it('ignores include in line comment', () => {
    const text = '// #include "fake.hlsl"\nvoid f() {}';
    expect(scanIncludes(text)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 实现**

```typescript
import type { Range } from '@unity-shader-nav/shared';

export interface IncludeDirective {
  path: string;
  /** Range of the path string (inside the quotes), 0-based line/character. */
  pathRange: Range;
  /** Line on which the directive appears. */
  line: number;
}

const INCLUDE_RE = /^\s*#\s*include\s*"([^"\n]+)"/;

export function scanIncludes(text: string): IncludeDirective[] {
  const lines = text.split(/\r?\n/);
  const out: IncludeDirective[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.replace(/\/\/.*$/, '');
    const m = INCLUDE_RE.exec(code);
    if (!m) continue;
    const path = m[1];
    const quoteStart = code.indexOf('"');
    const pathStart = quoteStart + 1;
    const pathEnd = pathStart + path.length;
    out.push({
      path,
      line: i,
      pathRange: {
        start: { line: i, character: pathStart },
        end:   { line: i, character: pathEnd   },
      },
    });
  }

  return out;
}
```

- [ ] **Step 3: 跑测试 + Commit**

```bash
npx vitest run tests/server/parser/include/lineScanner.test.ts
git add server/src/parser/include/lineScanner.ts tests/server/parser/include/lineScanner.test.ts
git commit -m "feat(plan-06): scan #include directives with path ranges"
```

---

## Task 2: 类型 + 上下文

**Files:**
- Create: `server/src/include/types.ts`
- Create: `server/src/include/index.ts`

- [ ] **Step 1: 类型**

```typescript
import type { ExtensionSettings } from '@unity-shader-nav/shared';

export interface IncludeContext {
  /** Absolute path; if undefined we are in standalone mode (no Unity root). */
  unityProjectRoot: string | undefined;
  includeDirectories: string[];
  /** Optional, filled in by plan 07. */
  packagePhysicalPaths?: Map<string, string>;
}

export interface ResolvedInclude {
  absolutePath: string;
  /** Search step that produced the hit, useful for logging. */
  via: 'relative' | 'assets' | 'package' | 'includeDirectories' | 'caseInsensitiveFallback';
  /** True if matched through case-insensitive fallback (warning). */
  caseInsensitive: boolean;
}

export function buildContext(settings: ExtensionSettings, autoDetectedRoot: string | undefined): IncludeContext {
  return {
    unityProjectRoot: settings.projectRoot || autoDetectedRoot,
    includeDirectories: settings.includeDirectories,
  };
}
```

- [ ] **Step 2: index.ts**

```typescript
export * from './types';
export { resolveInclude } from './resolver';
```

- [ ] **Step 3: Commit**

```bash
git add server/src/include/{types.ts,index.ts}
git commit -m "feat(plan-06): include resolver types"
```

---

## Task 3: 准备 fixture 项目

**Files:** 见 file structure 中的 `tests/server/include/fixtures/projectA/...`

- [ ] **Step 1: 创建目录与文件**

```bash
mkdir -p tests/server/include/fixtures/projectA/Assets/Shaders/Inner
mkdir -p tests/server/include/fixtures/projectA/Assets/CustomCG
mkdir -p tests/server/include/fixtures/projectA/ProjectSettings
mkdir -p tests/server/include/fixtures/projectA/Packages
touch tests/server/include/fixtures/projectA/{ProjectSettings,Packages}/.gitkeep
```

- [ ] **Step 2: 写文件**

`Assets/Shaders/Main.shader`:
```hlsl
Shader "T/Inc" {
  SubShader { Pass {
    HLSLPROGRAM
    #include "Common.hlsl"
    #include "Inner/Lighting.hlsl"
    #include "CustomCG/MyHelper.hlsl"
    ENDHLSL
  } }
}
```

`Assets/Shaders/Common.hlsl`:
```hlsl
float4 Common() { return 0; }
```

`Assets/Shaders/Inner/Lighting.hlsl`:
```hlsl
float3 Light() { return 0; }
```

`Assets/CustomCG/MyHelper.hlsl`:
```hlsl
float MyHelper() { return 0; }
```

- [ ] **Step 3: Commit**

```bash
git add tests/server/include/fixtures/projectA
git commit -m "test(plan-06): include resolver fixture project"
```

---

## Task 4: resolver — 相对路径优先

**Files:**
- Create: `server/src/include/resolver.ts`
- Create: `tests/server/include/resolver.test.ts`

- [ ] **Step 1: 失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { resolve as pathResolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInclude } from '../../../server/src/include/resolver';
import type { IncludeContext } from '../../../server/src/include/types';

const fixtureRoot = pathResolve(__dirname, 'fixtures/projectA');

function ctx(): IncludeContext {
  return { unityProjectRoot: fixtureRoot, includeDirectories: [] };
}

describe('resolveInclude: relative path wins', () => {
  it('resolves "Common.hlsl" from a file in the same directory', async () => {
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const r = await resolveInclude('Common.hlsl', fromUri, ctx());
    expect(r?.via).toBe('relative');
    expect(r?.absolutePath).toBe(join(fixtureRoot, 'Assets/Shaders/Common.hlsl'));
  });

  it('resolves "Inner/Lighting.hlsl" relative', async () => {
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const r = await resolveInclude('Inner/Lighting.hlsl', fromUri, ctx());
    expect(r?.absolutePath).toBe(join(fixtureRoot, 'Assets/Shaders/Inner/Lighting.hlsl'));
  });
});
```

- [ ] **Step 2: 实现**

```typescript
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IncludeContext, ResolvedInclude } from './types';

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function existsCaseSensitive(p: string): Promise<boolean> {
  if (!(await exists(p))) return false;
  // verify each segment matches case on disk
  const parts = p.split(/[\\/]/);
  let acc = parts[0] === '' ? '/' : parts[0];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === '') continue;
    const dir = i === 1 && acc === '/' ? '/' : acc;
    let entries: string[];
    try { entries = await fs.readdir(dir); } catch { return false; }
    if (!entries.includes(parts[i])) return false;
    acc = join(acc, parts[i]);
  }
  return true;
}

export async function resolveInclude(
  includePath: string,
  fromFileUri: string,
  ctx: IncludeContext,
): Promise<ResolvedInclude | null> {
  if (isAbsolute(includePath)) {
    if (await exists(includePath)) {
      return { absolutePath: includePath, via: 'relative', caseInsensitive: false };
    }
  }

  // Packages/... handled by plan 07; if seen here without a resolver, skip.
  if (includePath.startsWith('Packages/') && ctx.packagePhysicalPaths === undefined) {
    return null;
  }

  let fromPath: string;
  try { fromPath = fileURLToPath(fromFileUri); } catch { return null; }
  const fromDir = dirname(fromPath);

  const candidates: Array<{ path: string; via: ResolvedInclude['via'] }> = [];

  // 1. relative
  candidates.push({ path: pathResolve(fromDir, includePath), via: 'relative' });
  // 2. projectRoot/Assets
  if (ctx.unityProjectRoot) {
    candidates.push({
      path: join(ctx.unityProjectRoot, 'Assets', includePath),
      via: 'assets',
    });
  }
  // 3. Packages — plan 07 (handled below if provided)
  if (ctx.packagePhysicalPaths && includePath.startsWith('Packages/')) {
    // intentionally noop here, plan 07 will fill in.
  }
  // 4. user includeDirectories
  for (const dir of ctx.includeDirectories) {
    candidates.push({ path: join(dir, includePath), via: 'includeDirectories' });
  }

  for (const c of candidates) {
    if (await existsCaseSensitive(c.path)) {
      return { absolutePath: c.path, via: c.via, caseInsensitive: false };
    }
  }
  for (const c of candidates) {
    if (await exists(c.path)) {
      return { absolutePath: c.path, via: c.via, caseInsensitive: true };
    }
  }
  return null;
}

export { pathToFileURL };
```

- [ ] **Step 3: 跑测试，PASS。Commit**

```bash
npx vitest run tests/server/include/resolver.test.ts
git add server/src/include/resolver.ts tests/server/include/resolver.test.ts
git commit -m "feat(plan-06): include resolver relative-path search"
```

---

## Task 5: resolver — Assets fallback + includeDirectories

**Files:**
- Modify: `tests/server/include/resolver.test.ts`

- [ ] **Step 1: 追加测试**

```typescript
describe('resolveInclude: Assets fallback', () => {
  it('falls back to projectRoot/Assets when not relative', async () => {
    // 把 Main.shader 当作上下文，但 #include 一个不在同目录的路径
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const r = await resolveInclude('CustomCG/MyHelper.hlsl', fromUri, ctx());
    // relative 找不到（Shaders/CustomCG/ 不存在）；assets 命中 Assets/CustomCG/MyHelper.hlsl
    expect(r?.via).toBe('assets');
    expect(r?.absolutePath.endsWith('Assets/CustomCG/MyHelper.hlsl')).toBe(true);
  });
});

describe('resolveInclude: includeDirectories', () => {
  it('finds via user-configured directory', async () => {
    const extra = join(fixtureRoot, 'Assets/CustomCG');
    const c: IncludeContext = { unityProjectRoot: undefined, includeDirectories: [extra] };
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const r = await resolveInclude('MyHelper.hlsl', fromUri, c);
    expect(r?.via).toBe('includeDirectories');
    expect(r?.absolutePath.endsWith('MyHelper.hlsl')).toBe(true);
  });

  it('returns null when nothing matches', async () => {
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const r = await resolveInclude('does/not/exist.hlsl', fromUri, ctx());
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试，应该已经 PASS（Task 4 实现已包含 fallback 链）**

```bash
npx vitest run tests/server/include/resolver.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/server/include/resolver.test.ts
git commit -m "test(plan-06): resolver Assets fallback + includeDirectories"
```

---

## Task 6: 大小写敏感性 + fallback warning

**Files:**
- Create: `tests/server/include/fixtures/caseSensitivity/Assets/Shaders/Main.hlsl`
- Create: `tests/server/include/fixtures/caseSensitivity/Assets/Shaders/helper.hlsl`
- Create: `tests/server/include/fixtures/caseSensitivity/ProjectSettings/.gitkeep`
- Modify: `tests/server/include/resolver.test.ts`

- [ ] **Step 1: 建 fixture**

`Assets/Shaders/Main.hlsl`:
```hlsl
#include "Helper.hlsl"  // 大写 H，实际文件是 helper.hlsl
```

`Assets/Shaders/helper.hlsl`:
```hlsl
float h() { return 0; }
```

- [ ] **Step 2: 测试**

```typescript
const caseRoot = pathResolve(__dirname, 'fixtures/caseSensitivity');

describe('resolveInclude: case-insensitive fallback', () => {
  it('returns the file via case-insensitive match with warning flag', async () => {
    const fromUri = pathToFileURL(join(caseRoot, 'Assets/Shaders/Main.hlsl')).href;
    const c: IncludeContext = { unityProjectRoot: caseRoot, includeDirectories: [] };
    const r = await resolveInclude('Helper.hlsl', fromUri, c);

    // 在 macOS APFS 默认大小写不敏感，case-sensitive 检查会失败，落入 fallback
    // 在 Linux 严格大小写，relative 直接找不到，也走 fallback
    expect(r).not.toBeNull();
    expect(r?.caseInsensitive).toBe(true);
  });
});
```

> 注：macOS 上 `fs.access` 大小写不敏感，所以 `existsCaseSensitive` 第二轮 readdir 比较才是关键。Linux 上首轮 access 直接失败，第二轮 access 也失败（大小写不同），故需要"忽略大小写匹配"才能命中——下面的 Task 7 处理。

- [ ] **Step 3: 改进 resolver 加入显式大小写不敏感扫描**

修改 `resolver.ts`，在 fallback 阶段加 directory scan：

```typescript
async function findIgnoreCase(candidate: string): Promise<string | null> {
  const parts = candidate.split(/[\\/]/);
  let acc = parts[0] === '' ? '/' : parts[0];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === '') continue;
    let entries: string[];
    try { entries = await fs.readdir(acc || '/'); } catch { return null; }
    const want = parts[i].toLowerCase();
    const hit = entries.find((e) => e.toLowerCase() === want);
    if (!hit) return null;
    acc = join(acc, hit);
  }
  return acc;
}

// 在 resolveInclude 的"caseInsensitive fallback" 阶段调用
for (const c of candidates) {
  const found = await findIgnoreCase(c.path);
  if (found) {
    return { absolutePath: found, via: c.via, caseInsensitive: true };
  }
}
```

- [ ] **Step 4: 跑测试，PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/include/resolver.ts tests/server/include
git commit -m "feat(plan-06): case-insensitive fallback with warning flag"
```

---

## Task 7: Unity project root 自动检测

**Files:**
- Create: `server/src/workspace/detectUnityRoot.ts`
- Create: `tests/server/workspace/detectUnityRoot.test.ts`

- [ ] **Step 1: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { detectUnityRoot } from '../../../server/src/workspace/detectUnityRoot';

const fixtureA = resolve(__dirname, '../include/fixtures/projectA');

describe('detectUnityRoot', () => {
  it('returns root when both Assets/ and ProjectSettings/ exist', async () => {
    expect(await detectUnityRoot(fixtureA)).toBe(fixtureA);
  });

  it('walks up from a nested folder', async () => {
    const nested = join(fixtureA, 'Assets/Shaders/Inner');
    expect(await detectUnityRoot(nested)).toBe(fixtureA);
  });

  it('returns null when neither exists', async () => {
    expect(await detectUnityRoot('/tmp')).toBeNull();
  });
});
```

- [ ] **Step 2: 实现**

```typescript
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch { return false; }
}

export async function detectUnityRoot(startDir: string): Promise<string | null> {
  let cur = startDir;
  for (;;) {
    if ((await dirExists(join(cur, 'Assets'))) && (await dirExists(join(cur, 'ProjectSettings')))) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add server/src/workspace tests/server/workspace
git commit -m "feat(plan-06): Unity project root autodetect"
```

---

## Task 8: 接入 fileIndexer — include 作为 reference 入库

**Files:**
- Modify: `server/src/parser/hlsl/fileIndexer.ts`
- Modify: `shared/src/symbols.ts`（如需扩展 ReferenceContext 加 'include'）

- [ ] **Step 1: 扩展 ReferenceContext**

`shared/src/symbols.ts`:
```typescript
export type ReferenceContext =
  | 'call' | 'type' | 'member' | 'pragma' | 'identifier' | 'include';
```

- [ ] **Step 2: 修改 fileIndexer**

```typescript
import { scanIncludes } from '../include/lineScanner';

// 在 indexFile 内，针对每个 block 文本（或 pure .hlsl 全文）：
const incs = scanIncludes(blockText);
for (const inc of incs) {
  refs.push({
    name: inc.path,
    context: 'include',
    location: {
      uri,
      range: {
        start: { line: inc.pathRange.start.line + lineOffset, character: inc.pathRange.start.character },
        end:   { line: inc.pathRange.end.line   + lineOffset, character: inc.pathRange.end.character   },
      },
    },
  });
}
```

- [ ] **Step 3: 单测**

`tests/server/parser/hlsl/fileIndexer.test.ts` 追加：

```typescript
it('records #include directives as references with context=include', async () => {
  const text = `#include "Common.hlsl"\nfloat4 x() { return 0; }`;
  const idx = await indexFile('file:///t/a.hlsl', text);
  const inc = idx.references.find((r) => r.context === 'include');
  expect(inc?.name).toBe('Common.hlsl');
});
```

- [ ] **Step 4: 跑测 + Commit**

```bash
git add shared/src/symbols.ts server/src/parser/hlsl/fileIndexer.ts tests/server/parser/hlsl/fileIndexer.test.ts
git commit -m "feat(plan-06): record #include directives as references"
```

---

## Task 9: definition handler — F12 在 include 路径上

**Files:**
- Modify: `server/src/handlers/definition.ts`
- Modify: `server/src/server.ts`（注入 IncludeContext）
- Create: `tests/server/handlers/definition-include.test.ts`

- [ ] **Step 1: 修改 definition handler**

```typescript
import { resolveInclude } from '../include';
import { pathToFileURL } from 'node:url';

// 注入 ctx
export function registerDefinitionHandler(
  connection,
  documents,
  store,
  getIncludeCtx: () => IncludeContext,
) {
  connection.onDefinition(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const idx = store.get(params.textDocument.uri);

    // 1) include directive on this line?
    const lineText = doc.getText({
      start: { line: params.position.line, character: 0 },
      end:   { line: params.position.line + 1, character: 0 },
    });
    const incMatch = /^\s*#\s*include\s*"([^"]+)"/.exec(lineText.replace(/\/\/.*$/, ''));
    if (incMatch) {
      const inc = incMatch[1];
      // verify cursor is inside the quoted string
      const quoteCol = lineText.indexOf('"') + 1;
      const endCol = quoteCol + inc.length;
      if (params.position.character >= quoteCol && params.position.character <= endCol) {
        const resolved = await resolveInclude(inc, params.textDocument.uri, getIncludeCtx());
        if (resolved) {
          if (resolved.caseInsensitive) {
            connection.console.warn(`[UnityShaderNav] case-insensitive match: "${inc}" → ${resolved.absolutePath}`);
          }
          const targetUri = pathToFileURL(resolved.absolutePath).href;
          const targetRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
          return [{
            targetUri,
            targetRange,
            targetSelectionRange: targetRange,
            originSelectionRange: {
              start: { line: params.position.line, character: quoteCol },
              end:   { line: params.position.line, character: endCol },
            },
          }];
        }
        return null;
      }
    }

    // 2) symbol resolve (existing path)
    if (!idx) return null;
    const word = wordAt(doc.getText(), params.position);
    if (!word) return null;
    const links = resolveDefinition(idx, word.text, params.position);
    return links.length === 0 ? null : links.map((l) => ({ ...l, originSelectionRange: word.range }));
  });
}
```

- [ ] **Step 2: server.ts 注入 IncludeContext**

```typescript
import { detectUnityRoot } from './workspace/detectUnityRoot';
import { buildContext, type IncludeContext } from './include';

let includeCtx: IncludeContext = { unityProjectRoot: undefined, includeDirectories: [] };

async function refreshIncludeCtx(settings: ExtensionSettings): Promise<void> {
  const folders = (await connection.workspace.getWorkspaceFolders()) ?? [];
  const first = folders[0];
  const auto = first ? await detectUnityRoot(fileURLToPath(first.uri)) : null;
  includeCtx = buildContext(settings, auto ?? undefined);
}

connection.onInitialized(async () => {
  const settings = await loadSettings(connection);
  await refreshIncludeCtx(settings);
  table = new MacroPatternTable(settings.declarationMacros);
});

registerDefinitionHandler(connection, documents, store, () => includeCtx);
```

- [ ] **Step 3: 单测 handler（in-process）**

```typescript
import { describe, it, expect } from 'vitest';
import { resolveInclude } from '../../server/src/include';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(__dirname, '../server/include/fixtures/projectA');

describe('definition include integration (in-process)', () => {
  it('resolves Common.hlsl from Main.shader', async () => {
    const from = pathToFileURL(join(root, 'Assets/Shaders/Main.shader')).href;
    const r = await resolveInclude('Common.hlsl', from, {
      unityProjectRoot: root, includeDirectories: [],
    });
    expect(r?.absolutePath).toBe(join(root, 'Assets/Shaders/Common.hlsl'));
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add server/src/handlers/definition.ts server/src/server.ts tests/server/handlers
git commit -m "feat(plan-06): F12 on #include opens target file"
```

---

## Task 10: 端到端集成测

**Files:**
- Create: `tests/integration/client/include-jump.test.ts`
- Use fixtures from `tests/server/include/fixtures/projectA/`

- [ ] **Step 1: 测试**

```typescript
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import * as path from 'node:path';

suite('F12 on #include', () => {
  test('opens Common.hlsl', async () => {
    const root = path.resolve(__dirname, '../../server/include/fixtures/projectA');
    const fp = path.join(root, 'Assets/Shaders/Main.shader');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 800));

    // line index of #include "Common.hlsl" depends on fixture; find it dynamically
    let line = -1;
    for (let i = 0; i < doc.lineCount; i++) {
      if (doc.lineAt(i).text.includes('"Common.hlsl"')) { line = i; break; }
    }
    assert.ok(line >= 0);
    const col = doc.lineAt(line).text.indexOf('Common.hlsl') + 1;
    const pos = new vscode.Position(line, col);

    const links = await vscode.commands.executeCommand<any[]>(
      'vscode.executeDefinitionProvider', uri, pos,
    );
    assert.ok(links && links.length >= 1);
    const t = links[0];
    const tUri: vscode.Uri = t.targetUri ?? t.uri;
    assert.ok(tUri.fsPath.endsWith('Common.hlsl'));
  });
});
```

- [ ] **Step 2: 跑测 + Commit**

```bash
npm test
git add tests/integration/client/include-jump.test.ts
git commit -m "test(plan-06): e2e F12 on #include directive"
```

---

## Acceptance

1. ✅ 单元测试全过（lineScanner、resolver、detectUnityRoot、fileIndexer include refs）
2. ✅ 端到端测试通过（F12 在 `#include "Common.hlsl"` → 打开文件）
3. ✅ Spec §10 **Case 4**：F12 在 `#include` 的路径字符串上 → 直接打开目标文件
4. ✅ 大小写不敏感命中时 server log 有 warning
5. ✅ Packages 虚拟路径在本计划下返回 null（不报错），交由 Plan 07 处理
6. ✅ 路径搜索严格按 Spec §6.1 优先级：relative → Assets → (Packages, Plan 07) → includeDirectories

## Manual Verification

1. F5 → 打开 `tests/server/include/fixtures/projectA`
2. 打开 `Assets/Shaders/Main.shader`
3. 光标放在 `#include "Common.hlsl"` 的 `Common` 上 → F12 → 应跳到 `Common.hlsl`（光标定位到第 0 行）
4. 光标放在 `#include "Inner/Lighting.hlsl"` → F12 → 跳到 `Inner/Lighting.hlsl`
5. 把 `Common.hlsl` 改成大小写不同写法 `#include "common.hlsl"`，F12 仍能跳，但 Output 频道应有 case-insensitive warning

完成后进入 Plan 07。
