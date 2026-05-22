# Plan 07: PackageResolver & Cross-file Index 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 MVP 最后一块拼图：
1. 实现 `PackageResolver`（ADR-0002）：读 `Packages/packages-lock.json`，构建 `package_name → physical_path` 映射；接入 Plan 06 的 `IncludeResolver`，让 `#include "Packages/com.xxx/..."` 能解析。
2. 引入**全局** `SymbolIndex`：跨多个 `FileIndex` 聚合 `Map<name, SymbolEntry[]>`；F12 在用户文件中可以跳到 Packages 中的定义。
3. 实现"扩展激活时后台异步全量扫描"。
4. **多 root workspace 隔离**（Spec §8.4）：每个 workspace folder 独立维护索引与 PackageResolver。

覆盖 Spec §10 Case 2、3、9。完成本计划 = MVP 通过。

**Architecture:**
- `PackageResolver`：读 `packages-lock.json`（兼容三种字段写法），把每个包的物理路径解出。优先 `Packages/<embedded>`、其次 `Library/PackageCache/<package>@<hash>`，最后绝对 `file:` 协议。
- `Workspace`：以 workspace folder 为单元，持有一组 `{ unityRoot, packageResolver, includeCtx, indexStore, globalIndex, settings }`。多 root 时多个 Workspace 实例严格隔离。
- `GlobalSymbolIndex`：跨文件 `Map<name, SymbolEntry[]>`；增量插入/删除（filter by uri）。
- 后台全量扫描：在 `connection.onInitialized` 之后跑 `Workspace.bootstrap()`，进度通过 `WorkDoneProgress` 给客户端。

**Tech Stack:** Node `fs/promises`、`glob`（轻量 file-walk）、LSP `WorkDoneProgress`。

**Dependencies:** Plan 01-06。

---

## File Structure

新建：
```
server/src/packages/
├── lockfile.ts            # 解析 packages-lock.json
├── packageResolver.ts     # name → physical path 映射
└── index.ts

server/src/workspace/
├── workspace.ts           # Workspace 类
├── workspaceManager.ts    # 多 root 管理
├── walkFiles.ts           # 异步遍历用户文件
└── (detectUnityRoot.ts 已存在)

server/src/index/
├── globalIndex.ts         # GlobalSymbolIndex
└── (其他文件已存在)

tests/server/packages/
├── lockfile.test.ts
├── packageResolver.test.ts
└── fixtures/
    └── packages-lock-samples/
        ├── embedded.json
        ├── registry.json
        ├── git.json
        └── local.json
tests/server/workspace/
├── workspaceManager.test.ts
└── fixtures/
    ├── projectA/                  # 复用 Plan 06 的 fixture（或在此新建）
    │   ├── Assets/Shaders/...
    │   ├── Packages/
    │   │   ├── packages-lock.json
    │   │   └── com.example.urp/
    │   │       └── ShaderLibrary/Core.hlsl
    │   └── ProjectSettings/.gitkeep
    └── projectB/
        └── (同上但完全不同的代码)
tests/integration/client/
├── cross-file-jump.test.ts
└── multiroot.test.ts
```

修改：
- `server/src/include/types.ts` — `IncludeContext.packagePhysicalPaths` 已预留，本计划填上
- `server/src/include/resolver.ts` — 加 Packages 解析分支
- `server/src/server.ts` — 重写主流程：multi-root + workspace manager
- `client/src/extension.ts` — 状态栏切换 starting / ready / standalone

---

## Task 1: lockfile parser

**Files:**
- Create: `server/src/packages/lockfile.ts`
- Create: `tests/server/packages/lockfile.test.ts`
- Create: `tests/server/packages/fixtures/packages-lock-samples/*.json`

- [ ] **Step 1: fixture `embedded.json`**

```json
{
  "dependencies": {
    "com.example.urp": {
      "version": "file:com.example.urp",
      "depth": 0,
      "source": "embedded",
      "dependencies": {}
    },
    "com.unity.render-pipelines.core": {
      "version": "12.1.7",
      "depth": 1,
      "source": "builtin",
      "dependencies": {}
    }
  }
}
```

- [ ] **Step 2: fixture `registry.json`**

```json
{
  "dependencies": {
    "com.unity.render-pipelines.universal": {
      "version": "14.0.10",
      "depth": 0,
      "source": "registry",
      "dependencies": {},
      "url": "https://packages.unity.com",
      "hash": "abc123"
    }
  }
}
```

- [ ] **Step 3: fixture `git.json`**

```json
{
  "dependencies": {
    "com.example.myrp": {
      "version": "git+https://github.com/example/myrp.git#main",
      "depth": 0,
      "source": "git",
      "dependencies": {},
      "hash": "deadbeef"
    }
  }
}
```

- [ ] **Step 4: fixture `local.json`**

```json
{
  "dependencies": {
    "com.example.local": {
      "version": "file:../shared-rp",
      "depth": 0,
      "source": "local",
      "dependencies": {}
    }
  }
}
```

- [ ] **Step 5: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePackagesLock, resolvePackagePhysicalPath } from '../../../server/src/packages/lockfile';

const fixtures = (n: string) =>
  readFileSync(join(__dirname, 'fixtures/packages-lock-samples', n), 'utf8');

describe('parsePackagesLock', () => {
  it('extracts dependency entries with source/version', () => {
    const data = parsePackagesLock(fixtures('embedded.json'));
    expect(data['com.example.urp'].source).toBe('embedded');
    expect(data['com.unity.render-pipelines.core'].source).toBe('builtin');
  });
});

describe('resolvePackagePhysicalPath', () => {
  const projectRoot = '/proj';

  it('embedded → Packages/<name>', () => {
    expect(resolvePackagePhysicalPath('com.example.urp', { version: 'file:com.example.urp', source: 'embedded' }, projectRoot))
      .toBe('/proj/Packages/com.example.urp');
  });

  it('builtin → Library/PackageCache/<name>@<version>', () => {
    expect(resolvePackagePhysicalPath('com.unity.render-pipelines.core', { version: '12.1.7', source: 'builtin' }, projectRoot))
      .toBe('/proj/Library/PackageCache/com.unity.render-pipelines.core@12.1.7');
  });

  it('registry with hash → Library/PackageCache/<name>@<hash>', () => {
    expect(resolvePackagePhysicalPath('com.unity.render-pipelines.universal',
      { version: '14.0.10', source: 'registry', hash: 'abc123' }, projectRoot))
      .toBe('/proj/Library/PackageCache/com.unity.render-pipelines.universal@abc123');
  });

  it('git → Library/PackageCache/<name>@<hash>', () => {
    expect(resolvePackagePhysicalPath('com.example.myrp',
      { version: 'git+https://example.com', source: 'git', hash: 'deadbeef' }, projectRoot))
      .toBe('/proj/Library/PackageCache/com.example.myrp@deadbeef');
  });

  it('local file: protocol → resolved relative to project', () => {
    expect(resolvePackagePhysicalPath('com.example.local',
      { version: 'file:../shared-rp', source: 'local' }, projectRoot))
      .toBe(resolve('/proj/Packages', '../shared-rp'));
  });
});
```

- [ ] **Step 6: 实现**

```typescript
import { resolve, join, posix } from 'node:path';

export interface LockfileEntry {
  version: string;
  source?: 'embedded' | 'builtin' | 'registry' | 'git' | 'local' | string;
  hash?: string;
}

export interface Lockfile {
  [pkgName: string]: LockfileEntry;
}

export function parsePackagesLock(content: string): Lockfile {
  const obj = JSON.parse(content);
  const deps = obj?.dependencies ?? {};
  const out: Lockfile = {};
  for (const [name, raw] of Object.entries(deps as Record<string, any>)) {
    out[name] = {
      version: String(raw.version ?? ''),
      source: raw.source,
      hash: raw.hash,
    };
  }
  return out;
}

export function resolvePackagePhysicalPath(
  name: string,
  entry: LockfileEntry,
  projectRoot: string,
): string {
  const src = entry.source ?? '';

  if (src === 'embedded') {
    // version is "file:<dir-under-Packages>"
    const dir = entry.version.replace(/^file:/, '');
    return join(projectRoot, 'Packages', dir);
  }

  if (src === 'local') {
    const rel = entry.version.replace(/^file:/, '');
    return resolve(join(projectRoot, 'Packages'), rel);
  }

  if (src === 'builtin') {
    return join(projectRoot, 'Library/PackageCache', `${name}@${entry.version}`);
  }

  if (src === 'registry' || src === 'git') {
    const tag = entry.hash ?? entry.version;
    return join(projectRoot, 'Library/PackageCache', `${name}@${tag}`);
  }

  // 未知 source：退化为 Library/PackageCache/<name>@<version>
  return join(projectRoot, 'Library/PackageCache', `${name}@${entry.version}`);
}
```

- [ ] **Step 7: 跑测 + Commit**

```bash
npx vitest run tests/server/packages/lockfile.test.ts
git add server/src/packages/lockfile.ts tests/server/packages
git commit -m "feat(plan-07): packages-lock.json parser + physical path resolver"
```

---

## Task 2: PackageResolver

**Files:**
- Create: `server/src/packages/packageResolver.ts`
- Create: `server/src/packages/index.ts`
- Create: `tests/server/packages/packageResolver.test.ts`

- [ ] **Step 1: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PackageResolver } from '../../../server/src/packages';

async function makeFakeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usn-'));
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await mkdir(join(root, 'Library/PackageCache'), { recursive: true });

  await writeFile(join(root, 'Packages/packages-lock.json'), JSON.stringify({
    dependencies: {
      'com.unity.render-pipelines.universal': {
        version: '14.0.10', source: 'registry', hash: 'abc',
      },
      'com.example.embedded': {
        version: 'file:com.example.embedded', source: 'embedded',
      },
    },
  }));

  // create the embedded package directory so resolver can verify path exists
  await mkdir(join(root, 'Packages/com.example.embedded'), { recursive: true });
  await mkdir(join(root, 'Library/PackageCache/com.unity.render-pipelines.universal@abc'), { recursive: true });

  return root;
}

describe('PackageResolver', () => {
  it('builds map after load()', async () => {
    const root = await makeFakeProject();
    const pr = new PackageResolver(root);
    await pr.load();

    expect(pr.getPath('com.unity.render-pipelines.universal'))
      .toBe(join(root, 'Library/PackageCache/com.unity.render-pipelines.universal@abc'));
    expect(pr.getPath('com.example.embedded'))
      .toBe(join(root, 'Packages/com.example.embedded'));
    expect(pr.getPath('com.unknown')).toBeUndefined();
  });

  it('returns empty when packages-lock.json missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-empty-'));
    const pr = new PackageResolver(root);
    await pr.load();
    expect(pr.allPaths()).toEqual([]);
  });

  it('resolveIncludePath maps Packages/<name>/... to absolute path', async () => {
    const root = await makeFakeProject();
    const pr = new PackageResolver(root);
    await pr.load();
    expect(pr.resolveIncludePath('Packages/com.example.embedded/Foo.hlsl'))
      .toBe(join(root, 'Packages/com.example.embedded/Foo.hlsl'));
  });
});
```

- [ ] **Step 2: 实现**

```typescript
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parsePackagesLock, resolvePackagePhysicalPath } from './lockfile';

export class PackageResolver {
  private readonly map = new Map<string, string>();

  constructor(private readonly projectRoot: string) {}

  async load(): Promise<void> {
    this.map.clear();
    const lockPath = join(this.projectRoot, 'Packages/packages-lock.json');
    let content: string;
    try { content = await fs.readFile(lockPath, 'utf8'); }
    catch { return; }

    const lock = parsePackagesLock(content);
    for (const [name, entry] of Object.entries(lock)) {
      this.map.set(name, resolvePackagePhysicalPath(name, entry, this.projectRoot));
    }
  }

  getPath(packageName: string): string | undefined {
    return this.map.get(packageName);
  }

  allPaths(): Array<{ name: string; path: string }> {
    return [...this.map].map(([name, path]) => ({ name, path }));
  }

  /**
   * Convert "Packages/<name>/<rest>" to absolute physical path; returns null otherwise.
   */
  resolveIncludePath(virtualPath: string): string | null {
    if (!virtualPath.startsWith('Packages/')) return null;
    const rest = virtualPath.substring('Packages/'.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.substring(0, slash);
    const subpath = slash < 0 ? '' : rest.substring(slash + 1);
    const phys = this.map.get(name);
    if (!phys) return null;
    return subpath ? join(phys, subpath) : phys;
  }

  asIncludeContextMap(): Map<string, string> {
    return new Map(this.map);
  }
}
```

- [ ] **Step 3: index**

```typescript
export { PackageResolver } from './packageResolver';
export { parsePackagesLock, resolvePackagePhysicalPath } from './lockfile';
```

- [ ] **Step 4: 跑测 + Commit**

```bash
npx vitest run tests/server/packages/packageResolver.test.ts
git add server/src/packages/{packageResolver.ts,index.ts} tests/server/packages
git commit -m "feat(plan-07): PackageResolver from packages-lock.json"
```

---

## Task 3: 接入 include resolver — Packages 分支

**Files:**
- Modify: `server/src/include/resolver.ts`
- Modify: `tests/server/include/resolver.test.ts`

- [ ] **Step 1: 修改 resolver**

```typescript
// 在 buildContext + IncludeContext 中已经预留 packagePhysicalPaths: Map<string, string>
// 修改 resolveInclude:

if (includePath.startsWith('Packages/')) {
  const map = ctx.packagePhysicalPaths;
  if (map) {
    const rest = includePath.substring('Packages/'.length);
    const slash = rest.indexOf('/');
    const pkgName = slash < 0 ? rest : rest.substring(0, slash);
    const subpath = slash < 0 ? '' : rest.substring(slash + 1);
    const phys = map.get(pkgName);
    if (phys) {
      const abs = subpath ? join(phys, subpath) : phys;
      if (await existsCaseSensitive(abs)) {
        return { absolutePath: abs, via: 'package', caseInsensitive: false };
      }
      const ci = await findIgnoreCase(abs);
      if (ci) return { absolutePath: ci, via: 'package', caseInsensitive: true };
    }
  }
  return null;
}
```

- [ ] **Step 2: 测试**

```typescript
describe('resolveInclude: Packages/...', () => {
  it('resolves via PackageResolver map', async () => {
    const phys = join(fixtureRoot, 'Packages/com.example.urp');
    const c: IncludeContext = {
      unityProjectRoot: fixtureRoot,
      includeDirectories: [],
      packagePhysicalPaths: new Map([['com.example.urp', phys]]),
    };
    // 构造一个 Packages/.../Core.hlsl 文件
    // ...假设 ShaderLibrary/Core.hlsl 存在
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const r = await resolveInclude('Packages/com.example.urp/ShaderLibrary/Core.hlsl', fromUri, c);
    expect(r?.via).toBe('package');
    expect(r?.absolutePath).toBe(join(phys, 'ShaderLibrary/Core.hlsl'));
  });
});
```

- [ ] **Step 3: 补 fixture：在 `tests/server/include/fixtures/projectA/Packages/com.example.urp/ShaderLibrary/Core.hlsl` 写空文件**

```bash
mkdir -p tests/server/include/fixtures/projectA/Packages/com.example.urp/ShaderLibrary
echo 'float Core() { return 0; }' > tests/server/include/fixtures/projectA/Packages/com.example.urp/ShaderLibrary/Core.hlsl
```

- [ ] **Step 4: Commit**

```bash
git add server/src/include/resolver.ts tests/server/include
git commit -m "feat(plan-07): resolve Packages/* via PackageResolver map"
```

---

## Task 4: GlobalSymbolIndex

**Files:**
- Create: `server/src/index/globalIndex.ts`
- Create: `tests/server/index/globalIndex.test.ts`
- Modify: `server/src/index/index.ts`

- [ ] **Step 1: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { GlobalSymbolIndex } from '../../../server/src/index/globalIndex';
import type { FileIndex } from '@unity-shader-nav/shared';

const fileIndex = (uri: string, names: string[]): FileIndex => ({
  uri,
  references: [],
  symbols: names.map((n) => ({
    name: n, kind: 'function',
    location: { uri, range: { start:{line:0,character:0}, end:{line:0,character:0} } },
  })),
});

describe('GlobalSymbolIndex', () => {
  it('aggregates symbols across files', () => {
    const g = new GlobalSymbolIndex();
    g.upsert(fileIndex('file:///a.hlsl', ['foo']));
    g.upsert(fileIndex('file:///b.hlsl', ['foo', 'bar']));
    expect(g.lookup('foo')).toHaveLength(2);
    expect(g.lookup('bar')).toHaveLength(1);
    expect(g.lookup('zzz')).toEqual([]);
  });

  it('removes per-file entries on upsert', () => {
    const g = new GlobalSymbolIndex();
    g.upsert(fileIndex('file:///a.hlsl', ['foo', 'bar']));
    g.upsert(fileIndex('file:///a.hlsl', ['foo']));
    expect(g.lookup('bar')).toEqual([]);
    expect(g.lookup('foo')).toHaveLength(1);
  });

  it('removes everything for a uri on delete()', () => {
    const g = new GlobalSymbolIndex();
    g.upsert(fileIndex('file:///a.hlsl', ['foo']));
    g.delete('file:///a.hlsl');
    expect(g.lookup('foo')).toEqual([]);
  });
});
```

- [ ] **Step 2: 实现**

```typescript
import type { FileIndex, SymbolEntry } from '@unity-shader-nav/shared';

export class GlobalSymbolIndex {
  private readonly byName = new Map<string, SymbolEntry[]>();
  private readonly byUri  = new Map<string, SymbolEntry[]>();

  upsert(file: FileIndex): void {
    this.delete(file.uri);
    for (const sym of file.symbols) {
      const arr = this.byName.get(sym.name) ?? [];
      arr.push(sym);
      this.byName.set(sym.name, arr);
    }
    this.byUri.set(file.uri, file.symbols.slice());
  }

  delete(uri: string): void {
    const prev = this.byUri.get(uri);
    if (!prev) return;
    for (const sym of prev) {
      const arr = this.byName.get(sym.name);
      if (!arr) continue;
      const next = arr.filter((s) => s.location.uri !== uri);
      if (next.length === 0) this.byName.delete(sym.name);
      else this.byName.set(sym.name, next);
    }
    this.byUri.delete(uri);
  }

  lookup(name: string): SymbolEntry[] {
    return this.byName.get(name)?.slice() ?? [];
  }

  uris(): IterableIterator<string> {
    return this.byUri.keys();
  }
}
```

- [ ] **Step 3: 跑测 + Commit**

```bash
npx vitest run tests/server/index/globalIndex.test.ts
git add server/src/index/globalIndex.ts tests/server/index/globalIndex.test.ts
git commit -m "feat(plan-07): cross-file GlobalSymbolIndex"
```

---

## Task 5: symbolResolver — fallback 到全局

**Files:**
- Modify: `server/src/index/symbolResolver.ts`
- Modify: `tests/server/index/symbolResolver.test.ts`

- [ ] **Step 1: 修改签名**

```typescript
export function resolveDefinition(
  idx: FileIndex,
  global: GlobalSymbolIndex | null,
  name: string,
  refPos: Position,
): LocationLink[] {
  // 先做原有 scoped/per-file 查找；如果什么都没找到，再查 global
  // file-local globals already inside idx; the global step is for symbols defined in OTHER files
  // ...
}
```

实现：

```typescript
const localCandidates = idx.symbols.filter((s) => s.name === name);

// scoped 优先（同前）
const scoped = ...; if (scoped.length > 0) return [asLink(best)];

// file-level globals
const fileGlobals = localCandidates.filter(
  (s) => s.kind !== 'parameter' && s.kind !== 'localVariable',
);

// 全局符号（其他文件）
const otherGlobals = (global?.lookup(name) ?? []).filter(
  (s) => s.location.uri !== idx.uri &&
         s.kind !== 'parameter' && s.kind !== 'localVariable',
);

const combined = [...fileGlobals, ...otherGlobals];
return combined.map(asLink);
```

- [ ] **Step 2: 测试**

```typescript
it('falls back to GlobalSymbolIndex when not in current file', () => {
  const idx: FileIndex = { uri: 'file:///a.hlsl', symbols: [], references: [] };
  const g = new GlobalSymbolIndex();
  g.upsert({
    uri: 'file:///b.hlsl',
    references: [],
    symbols: [{
      name: 'Common', kind: 'function',
      location: { uri: 'file:///b.hlsl', range: { start:{line:3,character:7}, end:{line:3,character:13} } },
    }],
  });
  const r = resolveDefinition(idx, g, 'Common', { line: 0, character: 0 });
  expect(r).toHaveLength(1);
  expect(r[0].targetUri).toBe('file:///b.hlsl');
});
```

- [ ] **Step 3: 修改 definition handler 接收 global，调用新签名**

```typescript
const links = resolveDefinition(idx, getGlobalIndex(params.textDocument.uri), word.text, params.position);
```

- [ ] **Step 4: 跑测 + Commit**

```bash
git add server/src/index/symbolResolver.ts server/src/handlers/definition.ts tests/server/index/symbolResolver.test.ts
git commit -m "feat(plan-07): cross-file symbol resolution"
```

---

## Task 6: file walker — 列出待索引文件

**Files:**
- Create: `server/src/workspace/walkFiles.ts`
- Create: `tests/server/workspace/walkFiles.test.ts`

- [ ] **Step 1: 决策**：用原生 `fs.readdir(..., { withFileTypes: true })` + 手写 excludePatterns（minimatch 风格简化版）。不引入 `glob` 依赖以减小 vsix 体积。

- [ ] **Step 2: 实现**

```typescript
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

const HLSL_EXTS = new Set(['.shader', '.hlsl', '.cginc', '.hlslinc', '.compute']);

function matchesGlob(rel: string, pattern: string): boolean {
  // 简化：把 ** → .*, * → [^/]*，其它字符 escape
  const re = new RegExp('^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '@@DBL@@')
      .replace(/\*/g, '[^/]*')
      .replace(/@@DBL@@/g, '.*') + '$');
  return re.test(rel);
}

export async function walkFiles(
  root: string,
  excludePatterns: string[],
): Promise<string[]> {
  const out: string[] = [];

  async function recur(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (excludePatterns.some((p) => matchesGlob(rel, p) || matchesGlob('/' + rel, p))) continue;
      if (ent.isDirectory()) {
        await recur(abs);
      } else {
        const dotIdx = ent.name.lastIndexOf('.');
        const ext = dotIdx >= 0 ? ent.name.substring(dotIdx) : '';
        if (HLSL_EXTS.has(ext.toLowerCase())) out.push(abs);
      }
    }
  }

  await recur(root);
  return out;
}
```

- [ ] **Step 3: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { walkFiles } from '../../../server/src/workspace/walkFiles';

const root = resolve(__dirname, '../include/fixtures/projectA');

describe('walkFiles', () => {
  it('finds .shader and .hlsl files', async () => {
    const files = await walkFiles(root, ['**/Library/**', '**/Temp/**']);
    expect(files.some((f) => f.endsWith('Main.shader'))).toBe(true);
    expect(files.some((f) => f.endsWith('Common.hlsl'))).toBe(true);
  });

  it('excludes Packages from user walk (Packages is enumerated separately)', async () => {
    const files = await walkFiles(root, ['**/Library/**', 'Packages/**']);
    expect(files.every((f) => !f.includes('/Packages/'))).toBe(true);
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add server/src/workspace/walkFiles.ts tests/server/workspace/walkFiles.test.ts
git commit -m "feat(plan-07): walkFiles with excludePatterns"
```

---

## Task 7: Workspace 类（per-root 状态聚合）

**Files:**
- Create: `server/src/workspace/workspace.ts`
- Create: `tests/server/workspace/workspace.test.ts`

- [ ] **Step 1: 实现**

```typescript
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings, FileIndex } from '@unity-shader-nav/shared';

import { detectUnityRoot } from './detectUnityRoot';
import { walkFiles } from './walkFiles';
import { PackageResolver } from '../packages';
import { GlobalSymbolIndex, IndexStore } from '../index';
import { MacroPatternTable } from '../macros';
import { indexFile } from '../parser/hlsl';
import type { IncludeContext } from '../include';

export class Workspace {
  readonly folderUri: string;
  unityRoot: string | undefined;
  packageResolver: PackageResolver | undefined;
  includeCtx: IncludeContext;
  readonly store = new IndexStore();
  readonly global = new GlobalSymbolIndex();
  table: MacroPatternTable;
  settings: ExtensionSettings;

  constructor(folderUri: string, settings: ExtensionSettings) {
    this.folderUri = folderUri;
    this.settings = settings;
    this.table = new MacroPatternTable(settings.declarationMacros);
    this.includeCtx = { unityProjectRoot: undefined, includeDirectories: settings.includeDirectories };
  }

  isStandalone(): boolean { return this.unityRoot === undefined; }

  async bootstrap(connection: Connection): Promise<void> {
    const folderPath = fileURLToPath(this.folderUri);
    this.unityRoot = (await detectUnityRoot(folderPath)) ?? undefined;

    if (this.unityRoot) {
      this.packageResolver = new PackageResolver(this.unityRoot);
      await this.packageResolver.load();
      this.includeCtx = {
        unityProjectRoot: this.unityRoot,
        includeDirectories: this.settings.includeDirectories,
        packagePhysicalPaths: this.packageResolver.asIncludeContextMap(),
      };
    } else {
      // standalone: only same-file navigation works
      return;
    }

    await this.fullScan(connection);
  }

  private async indexAndStore(absPath: string): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    try {
      const text = await fs.readFile(absPath, 'utf8');
      const idx = await indexFile(uri, text, this.table);
      this.store.set(uri, idx);
      this.global.upsert(idx);
    } catch { /* ignore unreadable file */ }
  }

  async fullScan(connection: Connection): Promise<void> {
    if (!this.unityRoot) return;
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'indexing user files…', false);

    try {
      // 1) Walk user files
      const userFiles = await walkFiles(this.unityRoot, this.settings.excludePatterns);
      let done = 0;
      for (const f of userFiles) {
        await this.indexAndStore(f);
        if (++done % 25 === 0) progress.report(`${done}/${userFiles.length} files`);
      }

      // 2) Walk Packages from PackageResolver
      if (this.packageResolver) {
        progress.report('indexing Packages…');
        for (const { path } of this.packageResolver.allPaths()) {
          const pkgFiles = await walkFiles(path, ['**/Documentation~/**', '**/Samples~/**']);
          for (const f of pkgFiles) {
            await this.indexAndStore(f);
          }
        }
      }
    } finally {
      progress.done();
    }
  }

  /** Re-index a single document (called by document sync). */
  async reindex(uri: string, text: string): Promise<void> {
    const idx = await indexFile(uri, text, this.table);
    this.store.set(uri, idx);
    this.global.upsert(idx);
  }

  /** Remove a file from index (called on close/delete). */
  drop(uri: string): void {
    this.store.delete(uri);
    this.global.delete(uri);
  }
}
```

- [ ] **Step 2: 测试（in-process）**

```typescript
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Workspace } from '../../../server/src/workspace/workspace';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';

const fakeConnection: any = {
  window: { createWorkDoneProgress: async () => ({ begin(){}, report(){}, done(){} }) },
};

describe('Workspace.bootstrap', () => {
  it('indexes user files + Packages and populates global index', async () => {
    const folder = pathToFileURL(resolve(__dirname, '../include/fixtures/projectA')).href;
    const ws = new Workspace(folder, DEFAULT_SETTINGS);
    await ws.bootstrap(fakeConnection);

    expect(ws.isStandalone()).toBe(false);
    expect(ws.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(ws.global.lookup('Core').length).toBeGreaterThanOrEqual(1); // from Packages/com.example.urp
  });
});
```

> 需要先在 Plan 06 的 fixture 里补 `projectA/Packages/packages-lock.json`：

```json
{
  "dependencies": {
    "com.example.urp": {
      "version": "file:com.example.urp",
      "source": "embedded"
    }
  }
}
```

- [ ] **Step 3: 跑测 + Commit**

```bash
git add server/src/workspace/workspace.ts tests/server/workspace/workspace.test.ts tests/server/include/fixtures/projectA/Packages/packages-lock.json
git commit -m "feat(plan-07): Workspace with full scan + global index"
```

---

## Task 8: WorkspaceManager — 多 root 隔离

**Files:**
- Create: `server/src/workspace/workspaceManager.ts`
- Create: `tests/server/workspace/workspaceManager.test.ts`
- Modify: `server/src/workspace/index.ts`

- [ ] **Step 1: 实现**

```typescript
import { Workspace } from './workspace';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import { fileURLToPath } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';

export class WorkspaceManager {
  private readonly byFolder = new Map<string, Workspace>();

  list(): Workspace[] { return [...this.byFolder.values()]; }

  /** Resolve which Workspace owns a given file URI. */
  workspaceFor(fileUri: string): Workspace | undefined {
    try {
      const fp = fileURLToPath(fileUri);
      let best: { ws: Workspace; len: number } | undefined;
      for (const ws of this.byFolder.values()) {
        const folder = fileURLToPath(ws.folderUri);
        if (fp.startsWith(folder + '/') || fp === folder) {
          if (!best || folder.length > best.len) best = { ws, len: folder.length };
        }
      }
      return best?.ws;
    } catch { return undefined; }
  }

  async addFolder(folderUri: string, settings: ExtensionSettings, conn: Connection): Promise<void> {
    if (this.byFolder.has(folderUri)) return;
    const ws = new Workspace(folderUri, settings);
    this.byFolder.set(folderUri, ws);
    await ws.bootstrap(conn);
  }

  removeFolder(folderUri: string): void {
    this.byFolder.delete(folderUri);
  }
}
```

- [ ] **Step 2: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { WorkspaceManager } from '../../../server/src/workspace/workspaceManager';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';

const fakeConn: any = { window: { createWorkDoneProgress: async () => ({ begin(){}, report(){}, done(){} }) } };

describe('WorkspaceManager: multi-root', () => {
  it('isolates global indexes between two roots', async () => {
    const aRoot = pathToFileURL(resolve(__dirname, '../include/fixtures/projectA')).href;
    // make a minimal projectB on the fly
    // ... (略，可建临时目录或预置 fixture)
    const mgr = new WorkspaceManager();
    await mgr.addFolder(aRoot, DEFAULT_SETTINGS, fakeConn);

    const wsA = mgr.workspaceFor(pathToFileURL(resolve(__dirname, '../include/fixtures/projectA/Assets/Shaders/Common.hlsl')).href);
    expect(wsA?.folderUri).toBe(aRoot);
  });
});
```

> projectB 用一个临时目录即可，本测试主要验证 routing 不串。

- [ ] **Step 3: 更新 workspace/index.ts 出口**

```typescript
export { Workspace } from './workspace';
export { WorkspaceManager } from './workspaceManager';
export { detectUnityRoot } from './detectUnityRoot';
export { walkFiles } from './walkFiles';
```

- [ ] **Step 4: Commit**

```bash
git add server/src/workspace tests/server/workspace
git commit -m "feat(plan-07): WorkspaceManager multi-root isolation"
```

---

## Task 9: 重写 server.ts 主流程

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/src/handlers/documents.ts`
- Modify: `server/src/handlers/definition.ts`

- [ ] **Step 1: 重构 documents handler，按 uri 路由到 Workspace**

```typescript
import { WorkspaceManager } from '../workspace';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Connection } from 'vscode-languageserver/node';

export function registerDocuments(connection: Connection, mgr: WorkspaceManager): TextDocuments<TextDocument> {
  const documents = new TextDocuments(TextDocument);

  const reindex = async (doc: TextDocument): Promise<void> => {
    const ws = mgr.workspaceFor(doc.uri);
    if (!ws) return;
    await ws.reindex(doc.uri, doc.getText());
  };

  documents.onDidOpen((e) => { void reindex(e.document); });
  documents.onDidChangeContent((e) => { void reindex(e.document); });
  documents.onDidClose((e) => {
    const ws = mgr.workspaceFor(e.document.uri);
    ws?.drop(e.document.uri);
  });

  documents.listen(connection);
  return documents;
}
```

- [ ] **Step 2: definition handler 用 WorkspaceManager**

```typescript
export function registerDefinitionHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  mgr: WorkspaceManager,
): void {
  connection.onDefinition(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const ws = mgr.workspaceFor(params.textDocument.uri);
    if (!ws) return null;

    // (1) include directive branch
    // ... same as plan 06, but use ws.includeCtx

    // (2) symbol resolution
    const idx = ws.store.get(params.textDocument.uri);
    if (!idx) return null;
    const word = wordAt(doc.getText(), params.position);
    if (!word) return null;
    const links = resolveDefinition(idx, ws.global, word.text, params.position);
    return links.length === 0 ? null : links.map((l) => ({ ...l, originSelectionRange: word.range }));
  });
}
```

- [ ] **Step 3: server.ts**

```typescript
import { connection, createInitializeResult } from './connection';
import { WorkspaceManager } from './workspace';
import { registerDocuments } from './handlers/documents';
import { registerDefinitionHandler } from './handlers/definition';
import { loadSettings, onSettingsChanged } from './config/settings';

const mgr = new WorkspaceManager();

connection.onInitialize(() => createInitializeResult());

connection.onInitialized(async () => {
  const settings = await loadSettings(connection);
  const folders = (await connection.workspace.getWorkspaceFolders()) ?? [];
  for (const f of folders) {
    await mgr.addFolder(f.uri, settings, connection);
  }
  connection.workspace.onDidChangeWorkspaceFolders((evt) => {
    for (const removed of evt.removed) mgr.removeFolder(removed.uri);
    void (async () => {
      for (const added of evt.added) await mgr.addFolder(added.uri, settings, connection);
    })();
  });
});

onSettingsChanged(connection, async (settings) => {
  // 重新初始化所有 workspace
  for (const ws of mgr.list()) {
    ws.settings = settings;
    ws.table = new MacroPatternTable(settings.declarationMacros);
    await ws.bootstrap(connection);
  }
});

const documents = registerDocuments(connection, mgr);
registerDefinitionHandler(connection, documents, mgr);
connection.listen();
```

- [ ] **Step 4: build + Commit**

```bash
npm run build
git add server/src
git commit -m "feat(plan-07): rewire server to WorkspaceManager (multi-root)"
```

---

## Task 10: 端到端 — 跨文件跳转 + 多 root 隔离

**Files:**
- Create: `tests/integration/client/cross-file-jump.test.ts`
- Create: `tests/integration/client/multiroot.test.ts`
- Augment fixtures：在 projectA 的 Main.shader 里调用 `Common()` 和 `Core()`

- [ ] **Step 1: 改 Main.shader 加调用**

```hlsl
Shader "T/Inc" {
  SubShader { Pass {
    HLSLPROGRAM
    #include "Common.hlsl"
    #include "Packages/com.example.urp/ShaderLibrary/Core.hlsl"
    float4 main() { return Common() + Core(); }
    ENDHLSL
  } }
}
```

- [ ] **Step 2: 跨文件跳转测试**

```typescript
suite('F12 cross-file', () => {
  test('jumps to Common.hlsl', async () => {
    const fp = resolve(__dirname, '../../server/include/fixtures/projectA/Assets/Shaders/Main.shader');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 2500)); // wait for indexing

    const lineIdx = doc.getText().split('\n').findIndex((l) => l.includes('return Common()'));
    const col = doc.lineAt(lineIdx).text.indexOf('Common()') + 2;
    const pos = new vscode.Position(lineIdx, col);

    const links = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', uri, pos);
    assert.ok(links && links.length >= 1);
    const t = links[0];
    const targetUri: vscode.Uri = t.targetUri ?? t.uri;
    assert.ok(targetUri.fsPath.endsWith('Common.hlsl'));
  });

  test('jumps to Core() in Packages', async () => {
    // 类似上面，但用 Core()
    // 预期 targetUri.fsPath endsWith Core.hlsl
  });
});
```

- [ ] **Step 3: 多 root 测试**

```typescript
suite('Multi-root isolation', () => {
  test('symbol in projectA is invisible to projectB', async () => {
    // open two folders via vscode.workspace.updateWorkspaceFolders
    // ... 详见 test-electron 文档
    // 验证：在 projectB 的文件中 F12 一个只在 projectA 出现的名字 → 0 候选
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add tests/integration/client
git commit -m "test(plan-07): cross-file F12 + multi-root isolation"
```

---

## Task 11: Standalone mode 状态栏

**Files:**
- Modify: `client/src/extension.ts`
- Modify: `client/src/statusBar.ts`
- Modify: `server/src/server.ts` — initialized 阶段把 mode 推送给客户端

- [ ] **Step 1: 服务端定义自定义通知**

```typescript
// server/src/server.ts
connection.onInitialized(async () => {
  // ... bootstrap ...
  const allStandalone = mgr.list().every((w) => w.isStandalone());
  connection.sendNotification('unityShaderNav/mode', { mode: allStandalone ? 'standalone' : 'ready' });
});
```

- [ ] **Step 2: 客户端订阅**

```typescript
// client/src/client.ts 或 extension.ts
client.onNotification('unityShaderNav/mode', ({ mode }: { mode: 'standalone' | 'ready' }) => {
  statusBar.set(mode);
});
```

- [ ] **Step 3: 手动验证 + Commit**

```bash
git add client/src server/src
git commit -m "feat(plan-07): status bar reflects standalone/ready mode"
```

---

## Acceptance

1. ✅ 所有单测全过；packages、workspace、cross-file 都有覆盖
2. ✅ 集成测试通过：跨文件 F12、跨 Packages F12、多 root 不串
3. ✅ Spec §10 **Case 2**：F12 在同目录另一个 .hlsl 文件中定义的函数上 → 跳转
4. ✅ Spec §10 **Case 3**：F12 在 `TransformObjectToHClip`（或 fixture 中的 `Core`）→ 跳到 Packages 中的定义；多候选时返回数组
5. ✅ Spec §10 **Case 9**：multi-root，projectA 的文件 F12 仅返回 projectA 范围内候选
6. ✅ 状态栏在 Unity 项目下显示 `ready`，在 standalone 下显示 `standalone mode`

**至此 MVP 全部完成。**

## Manual Verification

1. F5 → 打开 `tests/server/include/fixtures/projectA`
2. 观察状态栏出现 `UnityShaderNav: ready`
3. Output 频道有 `[index] file:///.../Common.hlsl → N symbols`
4. 打开 `Main.shader`，光标在 `Core()` 调用上 → F12 → 跳到 `Packages/com.example.urp/ShaderLibrary/Core.hlsl`
5. 关掉 Unity project，打开任意单独 `.hlsl` → 状态栏切到 `standalone mode`，同文件 F12 仍工作

完成后进入 Plan 08。
