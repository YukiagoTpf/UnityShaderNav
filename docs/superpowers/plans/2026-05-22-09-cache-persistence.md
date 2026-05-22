# Plan 09: Cache Persistence 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 ADR-0004：把全量索引序列化到 `<projectRoot>/Library/UnityShaderNavCache/`；下次启动按 `(filepath, mtime, size)` 校验后增量加载，未变化的文件直接复用缓存，变化的文件重新 parse。Standalone 模式降级到 VSCode `globalStorageUri`。

**Architecture:**
- `CacheStore`：负责"读/写一份 workspace 的索引快照"。文件格式：单一 JSON `index.json`（gzip 可选 P2），含 `version`、`fingerprint`、`files: { uri, mtime, size, fileIndex }[]`。
- `fingerprint`：把跨文件影响索引正确性的三个维度打成 hash —— `grammarVersion`（vendored tree-sitter-hlsl.wasm 的版本字符串）、`settingsHash`（user settings 中影响索引的子集的稳定 hash：`declarationMacros` / `includeDirectories` / `excludePatterns`）、`macroTableHash`（内置 macro 白名单 + user macros 合并后的 hash）。任一变化整份缓存作废。
- `CacheManager`：在 `Workspace.bootstrap()` 时优先尝试 `load()`；命中后跳过 fullScan，改为 `validateAndRefresh()`（按 mtime/size 重 parse 失效文件）。在适当时机 `save()`。
- 缓存版本：硬编码 `CACHE_VERSION = 1`；不匹配直接丢弃。
- standalone 路径：传入 VSCode 的 `globalStorageUri`，按 workspace folder path 的哈希分桶。

**Tech Stack:** Node `fs/promises`。

**Dependencies:** Plan 01-08。

---

## File Structure

新建：
```
server/src/cache/
├── cacheStore.ts          # 文件 IO + 校验
├── cacheManager.ts        # 与 Workspace 协作的高层 API
└── index.ts

server/tests/cache/
├── cacheStore.test.ts
├── cacheManager.test.ts
└── fixtures/
    └── (临时目录用 tmp dir)
```

修改：
- `server/src/workspace/workspace.ts` — `bootstrap()` 先 try load，最后 save
- `server/src/server.ts` — `connection.onShutdown` 时 flush
- `client/src/extension.ts` — 把 `globalStorageUri.fsPath` 通过 initializationOptions 传给 server（standalone fallback 用）

---

## Task 1: shared types — CacheManifest

**Files:**
- Create: `shared/src/cache.ts`
- Modify: `shared/src/protocol.ts`

- [ ] **Step 1: 类型**

```typescript
import type { FileIndex } from './symbols';

export const CACHE_VERSION = 1;

/**
 * Fields that, if any of them changes between runs, invalidate the entire cache.
 * Each is a stable hex digest so the manifest stays JSON-friendly.
 */
export interface CacheFingerprint {
  /** SHA-1 of vendored tree-sitter-hlsl.wasm (or a baked-in semver if you prefer). */
  grammarVersion: string;
  /** SHA-1 over a canonical JSON of settings keys that influence indexing:
   *  declarationMacros, includeDirectories, excludePatterns. */
  settingsHash: string;
  /** SHA-1 over the resolved MacroPatternTable (builtin + user, sorted). */
  macroTableHash: string;
}

export interface CachedFile {
  uri: string;
  mtimeMs: number;
  size: number;
  index: FileIndex;
}

export interface CacheManifest {
  version: number;
  workspaceFolderUri: string;
  unityProjectRoot: string | null;
  createdAt: number;
  fingerprint: CacheFingerprint;
  files: CachedFile[];
}
```

- [ ] **Step 2: re-export**

```typescript
// shared/src/protocol.ts
export * from './cache';
```

- [ ] **Step 3: build + Commit**

```bash
npm run build -w @unity-shader-nav/shared
git add shared/src/{cache.ts,protocol.ts}
git commit -m "feat(plan-09): CacheManifest types"
```

---

## Task 2: CacheStore + Fingerprint 计算

**Files:**
- Create: `server/src/cache/cacheStore.ts`
- Create: `server/src/cache/fingerprint.ts`
- Create: `server/tests/cache/cacheStore.test.ts`
- Create: `server/tests/cache/fingerprint.test.ts`

- [ ] **Step 1: 实现 fingerprint 计算**

```typescript
// server/src/cache/fingerprint.ts
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { ExtensionSettings, CacheFingerprint } from '@unity-shader-nav/shared';
import { BUILTIN_DECLARATION_MACROS, BUILTIN_REFERENCE_MACROS } from '../macros/builtin';

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export async function grammarVersionHash(wasmPath: string): Promise<string> {
  // Hash the bytes of the vendored WASM so any grammar bump invalidates cache.
  // If the file is unreadable, return a fixed sentinel so cache reload still works
  // in tests where wasm isn't shipped.
  try {
    const buf = await fs.readFile(wasmPath);
    return createHash('sha1').update(buf).digest('hex');
  } catch {
    return 'no-wasm';
  }
}

export function settingsHash(s: ExtensionSettings): string {
  // Only hash fields that actually affect indexing — projectRoot etc. don't.
  const subset = {
    declarationMacros: [...s.declarationMacros]
      .map((m) => ({ pattern: m.pattern, kind: m.kind }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern)),
    includeDirectories: [...s.includeDirectories].sort(),
    excludePatterns: [...s.excludePatterns].sort(),
  };
  return sha1(JSON.stringify(subset));
}

export function macroTableHash(userMacros: ExtensionSettings['declarationMacros']): string {
  const all = [
    ...BUILTIN_DECLARATION_MACROS.map((m) => ({ p: m.pattern, k: m.kind, src: 'builtin-decl' })),
    ...BUILTIN_REFERENCE_MACROS.map((m) => ({ p: m.pattern, k: m.kind, src: 'builtin-ref' })),
    ...userMacros.map((m) => ({ p: m.pattern, k: m.kind, src: 'user' })),
  ].sort((a, b) => a.p.localeCompare(b.p));
  return sha1(JSON.stringify(all));
}

export async function buildFingerprint(
  settings: ExtensionSettings,
  wasmPath: string,
): Promise<CacheFingerprint> {
  return {
    grammarVersion: await grammarVersionHash(wasmPath),
    settingsHash: settingsHash(settings),
    macroTableHash: macroTableHash(settings.declarationMacros),
  };
}

export function fingerprintsEqual(a: CacheFingerprint, b: CacheFingerprint): boolean {
  return a.grammarVersion === b.grammarVersion
      && a.settingsHash    === b.settingsHash
      && a.macroTableHash  === b.macroTableHash;
}
```

- [ ] **Step 2: 测试 fingerprint 稳定性**

```typescript
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import {
  settingsHash, macroTableHash, fingerprintsEqual, buildFingerprint,
} from '../../src/cache/fingerprint';

describe('settingsHash', () => {
  it('is stable across permutations of included fields', () => {
    const a = { ...DEFAULT_SETTINGS, includeDirectories: ['x', 'y'] };
    const b = { ...DEFAULT_SETTINGS, includeDirectories: ['y', 'x'] };
    expect(settingsHash(a)).toBe(settingsHash(b));
  });

  it('changes when a user macro is added', () => {
    const a = { ...DEFAULT_SETTINGS };
    const b = { ...DEFAULT_SETTINGS, declarationMacros: [{ pattern: 'M($name)', kind: 'variable' as const }] };
    expect(settingsHash(a)).not.toBe(settingsHash(b));
  });
});

describe('macroTableHash', () => {
  it('different user macros produce different hashes', () => {
    const a = macroTableHash([]);
    const b = macroTableHash([{ pattern: 'X($name)', kind: 'variable' }]);
    expect(a).not.toBe(b);
  });
});

describe('buildFingerprint + fingerprintsEqual', () => {
  it('equal inputs → equal fingerprints', async () => {
    const f1 = await buildFingerprint(DEFAULT_SETTINGS, '/nope');
    const f2 = await buildFingerprint(DEFAULT_SETTINGS, '/nope');
    expect(fingerprintsEqual(f1, f2)).toBe(true);
  });
});
```

- [ ] **Step 3: 实现 CacheStore（多一步 fingerprint 校验）**

```typescript
// server/src/cache/cacheStore.ts
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CacheManifest, CacheFingerprint } from '@unity-shader-nav/shared';
import { CACHE_VERSION } from '@unity-shader-nav/shared';
import { fingerprintsEqual } from './fingerprint';

export class CacheStore {
  constructor(private readonly dir: string) {}

  private get path(): string { return join(this.dir, 'index.json'); }

  /**
   * @param expectedFingerprint  When provided, the manifest is discarded if its
   *                             fingerprint doesn't match — grammar bumps, user
   *                             macro edits, or include path changes invalidate
   *                             the whole cache (B10).
   */
  async load(expectedFingerprint?: CacheFingerprint): Promise<CacheManifest | null> {
    let content: string;
    try { content = await fs.readFile(this.path, 'utf8'); }
    catch { return null; }
    let parsed: CacheManifest;
    try { parsed = JSON.parse(content); }
    catch { return null; }
    if (parsed.version !== CACHE_VERSION) return null;
    if (!parsed.fingerprint) return null;
    if (expectedFingerprint && !fingerprintsEqual(parsed.fingerprint, expectedFingerprint)) {
      return null;
    }
    return parsed;
  }

  async save(manifest: CacheManifest): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.path + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(manifest), 'utf8');
    await fs.rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    try { await fs.rm(this.path); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: 测试 store**（保留原有用例，并新增）

```typescript
it('returns null when fingerprint mismatches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usn-cache-fp-'));
  const store = new CacheStore(dir);

  const fpA: CacheFingerprint = { grammarVersion: 'a', settingsHash: 's1', macroTableHash: 'm1' };
  const fpB: CacheFingerprint = { grammarVersion: 'b', settingsHash: 's1', macroTableHash: 'm1' };

  await store.save({
    version: CACHE_VERSION,
    workspaceFolderUri: 'file:///x',
    unityProjectRoot: '/x',
    createdAt: Date.now(),
    fingerprint: fpA,
    files: [],
  });
  expect(await store.load(fpA)).not.toBeNull();
  expect(await store.load(fpB)).toBeNull();

  await rm(dir, { recursive: true });
});
```

- [ ] **Step 5: 跑测 + Commit**

```bash
npx vitest run server/tests/cache/cacheStore.test.ts server/tests/cache/fingerprint.test.ts
git add server/src/cache/{cacheStore.ts,fingerprint.ts} server/tests/cache
git commit -m "feat(plan-09): CacheStore + fingerprint (grammar/settings/macros)"
```

---

## Task 3: 缓存目录选择策略

**Files:**
- Modify: `server/src/cache/index.ts`（新文件）
- Create: `server/src/cache/cacheLocation.ts`

逻辑：
- 若 `unityProjectRoot` 存在 → `<root>/Library/UnityShaderNavCache/`
- 否则 → `<globalStorageUri>/standalone/<sha1(folderUri)>/`

- [ ] **Step 1: 实现**

```typescript
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface CacheLocationInput {
  unityProjectRoot: string | undefined;
  workspaceFolderUri: string;
  globalStorageDir: string | undefined; // injected by extension client
}

export function chooseCacheDir(input: CacheLocationInput): string | null {
  if (input.unityProjectRoot) {
    return join(input.unityProjectRoot, 'Library', 'UnityShaderNavCache');
  }
  if (input.globalStorageDir) {
    const hash = createHash('sha1').update(input.workspaceFolderUri).digest('hex').slice(0, 16);
    return join(input.globalStorageDir, 'standalone', hash);
  }
  return null;
}
```

- [ ] **Step 2: 单测**

```typescript
import { describe, it, expect } from 'vitest';
import { chooseCacheDir } from '../../src/cache/cacheLocation';
import { join } from 'node:path';

describe('chooseCacheDir', () => {
  it('uses Library/UnityShaderNavCache under unity root', () => {
    expect(chooseCacheDir({
      unityProjectRoot: '/proj', workspaceFolderUri: 'file:///proj', globalStorageDir: '/gs',
    })).toBe(join('/proj', 'Library', 'UnityShaderNavCache'));
  });

  it('falls back to globalStorageDir bucket in standalone mode', () => {
    const out = chooseCacheDir({
      unityProjectRoot: undefined, workspaceFolderUri: 'file:///x', globalStorageDir: '/gs',
    });
    expect(out).toMatch(/^\/gs\/standalone\/[a-f0-9]{16}$/);
  });

  it('returns null when no location available', () => {
    expect(chooseCacheDir({
      unityProjectRoot: undefined, workspaceFolderUri: 'file:///x', globalStorageDir: undefined,
    })).toBeNull();
  });
});
```

- [ ] **Step 3: index.ts**

```typescript
export { CacheStore } from './cacheStore';
export { chooseCacheDir } from './cacheLocation';
export type { CacheLocationInput } from './cacheLocation';
export { CacheManager } from './cacheManager';
```

- [ ] **Step 4: Commit**

```bash
git add server/src/cache server/tests/cache
git commit -m "feat(plan-09): cache directory selection"
```

---

## Task 4: 客户端传递 globalStorageUri

**Files:**
- Modify: `client/src/client.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: client 把 globalStorageUri 通过 initializationOptions 传**

```typescript
// client/src/client.ts
const clientOptions: LanguageClientOptions = {
  documentSelector: [...],
  initializationOptions: {
    globalStorageDir: context.globalStorageUri.fsPath,
  },
};
```

- [ ] **Step 2: server 读取**

```typescript
// server/src/server.ts
let globalStorageDir: string | undefined;
connection.onInitialize((params) => {
  globalStorageDir = (params.initializationOptions as any)?.globalStorageDir;
  return createInitializeResult();
});
```

并把 `globalStorageDir` 透传给 `Workspace` 构造或 bootstrap。

- [ ] **Step 3: Commit**

```bash
git add client/src server/src
git commit -m "feat(plan-09): pass globalStorageDir from client to server"
```

---

## Task 5: CacheManager — 加载、校验、保存

**Files:**
- Create: `server/src/cache/cacheManager.ts`
- Create: `server/tests/cache/cacheManager.test.ts`

- [ ] **Step 1: 实现**

```typescript
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CacheManifest, CachedFile, FileIndex } from '@unity-shader-nav/shared';
import { CACHE_VERSION } from '@unity-shader-nav/shared';
import { CacheStore } from './cacheStore';

export class CacheManager {
  constructor(private readonly store: CacheStore) {}

  async load(): Promise<CacheManifest | null> {
    return this.store.load();
  }

  async save(manifest: CacheManifest): Promise<void> {
    await this.store.save(manifest);
  }

  /**
   * Given a candidate cached file, decide if we can reuse it.
   * Returns true when (mtime, size) on disk still match the cached values.
   */
  async isValid(file: CachedFile): Promise<boolean> {
    try {
      const fp = fileURLToPath(file.uri);
      const st = await fs.stat(fp);
      return st.mtimeMs === file.mtimeMs && st.size === file.size;
    } catch { return false; }
  }

  /** Returns a fresh CachedFile record by stat'ing the path. */
  async snapshot(uri: string, index: FileIndex): Promise<CachedFile | null> {
    try {
      const fp = fileURLToPath(uri);
      const st = await fs.stat(fp);
      return { uri, mtimeMs: st.mtimeMs, size: st.size, index };
    } catch { return null; }
  }

  buildManifest(
    workspaceFolderUri: string,
    unityProjectRoot: string | null,
    fingerprint: CacheFingerprint,
    files: CachedFile[],
  ): CacheManifest {
    return {
      version: CACHE_VERSION,
      workspaceFolderUri,
      unityProjectRoot,
      createdAt: Date.now(),
      fingerprint,
      files,
    };
  }
}
```

- [ ] **Step 2: 测试 isValid**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CacheManager } from '../../src/cache/cacheManager';
import { CacheStore } from '../../src/cache/cacheStore';

describe('CacheManager.isValid', () => {
  it('returns true when mtime and size unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-mgr-'));
    const fp = join(dir, 'a.hlsl');
    await writeFile(fp, 'float4 x;');
    const st = await stat(fp);
    const mgr = new CacheManager(new CacheStore(dir));

    const ok = await mgr.isValid({
      uri: pathToFileURL(fp).href,
      mtimeMs: st.mtimeMs, size: st.size,
      index: { uri: '', symbols: [], references: [] },
    });
    expect(ok).toBe(true);

    await rm(dir, { recursive: true });
  });

  it('returns false when file changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-mgr-2-'));
    const fp = join(dir, 'a.hlsl');
    await writeFile(fp, 'float4 x;');
    const st = await stat(fp);
    await new Promise((r) => setTimeout(r, 30));
    await writeFile(fp, 'float4 xx; // changed');
    const mgr = new CacheManager(new CacheStore(dir));
    const ok = await mgr.isValid({
      uri: pathToFileURL(fp).href,
      mtimeMs: st.mtimeMs, size: st.size,
      index: { uri: '', symbols: [], references: [] },
    });
    expect(ok).toBe(false);

    await rm(dir, { recursive: true });
  });
});
```

- [ ] **Step 3: 跑测 + Commit**

```bash
git add server/src/cache/cacheManager.ts server/tests/cache/cacheManager.test.ts
git commit -m "feat(plan-09): CacheManager with mtime/size validation"
```

---

## Task 6: Workspace 集成 — 启动时优先读缓存

**Files:**
- Modify: `server/src/workspace/workspace.ts`

- [ ] **Step 1: 修改 `bootstrap()`** —— Plan 07 已把 `globalStorageDir` 作为可选参数预留（B5 防护），本 Step 把它接到 `CacheManager` 上。签名保持不变。

```typescript
async bootstrap(conn: Connection, globalStorageDir?: string): Promise<void> {
  // 1) detect unity root (同前)
  // 2) packageResolver init
  // ...

  const cacheDir = chooseCacheDir({
    unityProjectRoot: this.unityRoot,
    workspaceFolderUri: this.folderUri,
    globalStorageDir,
  });
  if (cacheDir) {
    this.cache = new CacheManager(new CacheStore(cacheDir));
    // Fingerprint over grammar wasm + settings + macro table. Any change → cache invalid.
    const wasmPath = join(__dirname, '..', '..', 'grammars', 'tree-sitter-hlsl.wasm');
    this.fingerprint = await buildFingerprint(this.settings, wasmPath);
    const manifest = await this.cache.load(this.fingerprint);
    if (manifest) {
      await this.bootstrapFromCache(conn, manifest);
      return;
    }
  }

  await this.fullScan(conn);
  await this.persist();
}

private async bootstrapFromCache(conn: Connection, manifest: CacheManifest): Promise<void> {
  const progress = await conn.window.createWorkDoneProgress();
  progress.begin('UnityShaderNav', undefined, 'restoring cache…', false);
  const refreshQueue: string[] = [];

  for (const cf of manifest.files) {
    if (await this.cache!.isValid(cf)) {
      this.store.set(cf.uri, cf.index);
      this.global.upsert(cf.index);
    } else {
      refreshQueue.push(cf.uri);
    }
  }
  progress.report(`re-parsing ${refreshQueue.length} changed files…`);
  for (const uri of refreshQueue) {
    try {
      const fp = fileURLToPath(uri);
      const text = await fs.readFile(fp, 'utf8');
      await this.reindex(uri, text);
    } catch {
      // file gone — just drop from index
    }
  }
  // also walk newly-added files (very cheap mode: full walk again, skip already-indexed)
  if (this.unityRoot) {
    const userFiles = await walkFiles(this.unityRoot, this.settings.excludePatterns);
    for (const fp of userFiles) {
      const uri = pathToFileURL(fp).href;
      if (!this.store.get(uri)) {
        const text = await fs.readFile(fp, 'utf8');
        await this.reindex(uri, text);
      }
    }
  }
  progress.done();
  await this.persist();
}

async persist(): Promise<void> {
  if (!this.cache) return;
  const records: CachedFile[] = [];
  for (const uri of this.global.uris()) {
    const idx = this.store.get(uri);
    if (!idx) continue;
    const snap = await this.cache.snapshot(uri, idx);
    if (snap) records.push(snap);
  }
  const manifest = this.cache.buildManifest(
    this.folderUri, this.unityRoot ?? null, this.fingerprint!, records,
  );
  await this.cache.save(manifest);
}
```

- [ ] **Step 2: 在每次 `applyChanges` / `rebuild` 之后 `await persist()`**

可以选择"延迟保存"——在变更后 5s 防抖再 persist，避免高频写盘。MVP 阶段直接每次 persist 即可。

- [ ] **Step 3: Commit**

```bash
git add server/src/workspace/workspace.ts
git commit -m "feat(plan-09): Workspace bootstraps from cache when available"
```

---

## Task 7: 集成测 — 关闭后再开冷启动 < 4s

**Files:**
- Create: `server/tests/cache/coldStart.test.ts`

- [ ] **Step 1: 测试（in-process）**

```typescript
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { Workspace } from '../../src/workspace/workspace';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';

const fakeConn: any = { window: { createWorkDoneProgress: async () => ({ begin(){}, report(){}, done(){} }) } };

describe('cold start with cache', () => {
  it('second bootstrap is faster than first', async () => {
    const root = resolve(__dirname, '../include/fixtures/projectA');
    const cacheDir = resolve(root, 'Library/UnityShaderNavCache');
    await rm(cacheDir, { recursive: true, force: true });

    // first run
    const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
    const t1 = Date.now();
    await ws1.bootstrap(fakeConn, undefined);
    const cold = Date.now() - t1;

    // second run
    const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
    const t2 = Date.now();
    await ws2.bootstrap(fakeConn, undefined);
    const warm = Date.now() - t2;

    expect(ws2.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    // warm should be noticeably faster on big projects; on tiny fixture both are
    // fast — at minimum it should not be slower
    expect(warm).toBeLessThanOrEqual(cold + 100);

    await rm(cacheDir, { recursive: true, force: true });
  }, 60_000);
});
```

> 时间断言较弱（fixture 太小），主要保证逻辑正确。真实大项目下另行手测。

- [ ] **Step 2: Commit**

```bash
git add server/tests/cache/coldStart.test.ts
git commit -m "test(plan-09): cold-start cache roundtrip"
```

---

## Task 8: shutdown / 异常退出处理

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: 注册 shutdown**

```typescript
connection.onShutdown(async () => {
  await Promise.all(mgr.list().map((ws) => ws.persist()));
});
```

- [ ] **Step 2: 由于已经在 bootstrap / applyChanges 之后 persist，shutdown 只是兜底。Commit**

```bash
git add server/src/server.ts
git commit -m "feat(plan-09): persist cache on shutdown"
```

---

## Acceptance

1. ✅ 单元测试全过（含 fingerprint 稳定性 + mismatch 失效）
2. ✅ 真实 URP 项目下首次冷启动后，`Library/UnityShaderNavCache/index.json` 存在且 > 100KB
3. ✅ 关闭 VSCode 重开后状态栏 ready 速度肉眼可感更快；Output 里 `restoring cache…` 出现
4. ✅ 删掉 `Library/` 后重启 → 走全量重建，无报错
5. ✅ Standalone 模式下缓存写入 globalStorageUri 下的 `standalone/<hash>/index.json`
6. ✅ 修改 `CACHE_VERSION` 常量到 2，重启 → 旧缓存被丢弃，走全量
7. ✅ 替换 `server/grammars/tree-sitter-hlsl.wasm` 后重启 → fingerprint 不匹配，旧缓存被丢弃（B10）
8. ✅ 在 settings 增删 `declarationMacros` 或 `includeDirectories` 后重启 → fingerprint 不匹配，旧缓存被丢弃（B10）

## Manual Verification

1. F5 → 打开一个有 URP/HDRP 的真实项目
2. 第一次启动等待 ready
3. 关闭 VSCode、再开 → 状态栏快速变 ready，Output `restoring cache…`
4. `ls -lh <project>/Library/UnityShaderNavCache/` 看到 `index.json`
5. 删 `Library/` 后再开，依然能正常工作

完成后进入 Plan 10。
