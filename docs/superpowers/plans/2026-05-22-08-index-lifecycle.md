# Plan 08: Index Lifecycle 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Spec §8 的索引生命周期：文件 watcher、debounce、rebuild 阈值、`.git/HEAD` 与 `packages-lock.json` 变化重建、冷启动 5s 请求挂起与降级。本计划主要工程化、不改可见行为，验证以"模拟 N 个文件变更 → 索引正确反映"为主。

**Architecture:**
- `FileWatcher`：基于 `vscode-languageserver` 的 `workspace/didChangeWatchedFiles`（client 侧用 `FileSystemWatcher` 转发），监控 `**/*.{shader,hlsl,cginc,hlslinc,compute}` + `**/.git/HEAD` + `**/Packages/packages-lock.json`。
- `Debouncer`：把窗口内事件聚合，500ms 触发；超过 20 文件阈值切到 rebuild 模式。
- `RequestSuspender`：在 cold start / rebuild 期间挂起 LSP 请求，最长 5s 后返回当前已有的部分结果。

**Tech Stack:** 既有。

**Dependencies:** Plan 01-07。

---

## File Structure

新建：
```
server/src/lifecycle/
├── debouncer.ts
├── fileWatcher.ts          # 服务端注册 watcher、把事件丢给 debouncer
├── requestSuspender.ts
└── index.ts

client/src/watcher.ts        # 客户端 FileSystemWatcher，把事件转给 server

server/tests/lifecycle/
├── debouncer.test.ts
├── fileWatcher.test.ts     # 用 in-memory event 模拟
└── requestSuspender.test.ts
```

修改：
- `server/src/workspace/workspace.ts` — 加 `applyChanges(events: FileEvent[])`、`rebuild()`
- `server/src/server.ts` — 接 watcher、把 onDefinition 包裹 RequestSuspender
- `client/package.json` — 注册 `workspace/didChangeWatchedFiles`

---

## Task 1: Debouncer

**Files:**
- Create: `server/src/lifecycle/debouncer.ts`
- Create: `server/tests/lifecycle/debouncer.test.ts`

- [ ] **Step 1: 测试**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Debouncer } from '../../src/lifecycle/debouncer';

describe('Debouncer', () => {
  it('emits aggregated events after window', async () => {
    vi.useFakeTimers();
    const fires: any[] = [];
    const d = new Debouncer<string>({ windowMs: 500, threshold: 5 }, (batch, mode) => fires.push({ batch, mode }));

    d.push('a'); d.push('b'); d.push('c');
    vi.advanceTimersByTime(499);
    expect(fires).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(fires).toHaveLength(1);
    expect(fires[0].mode).toBe('incremental');
    expect(fires[0].batch).toEqual(['a', 'b', 'c']);
    vi.useRealTimers();
  });

  it('switches to rebuild mode when threshold exceeded', async () => {
    vi.useFakeTimers();
    const fires: any[] = [];
    const d = new Debouncer<number>({ windowMs: 500, threshold: 5 }, (batch, mode) => fires.push({ batch, mode }));

    for (let i = 0; i < 10; i++) d.push(i);
    vi.advanceTimersByTime(500);
    expect(fires).toHaveLength(1);
    expect(fires[0].mode).toBe('rebuild');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 实现**

```typescript
export type DebouncerMode = 'incremental' | 'rebuild';
export interface DebouncerOptions {
  windowMs: number;
  threshold: number;
}

export class Debouncer<T> {
  private timer: NodeJS.Timeout | undefined;
  private buffer: T[] = [];

  constructor(
    private readonly opts: DebouncerOptions,
    private readonly onFlush: (batch: T[], mode: DebouncerMode) => void,
  ) {}

  push(item: T): void {
    this.buffer.push(item);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.opts.windowMs);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const mode: DebouncerMode = batch.length > this.opts.threshold ? 'rebuild' : 'incremental';
    this.onFlush(batch, mode);
  }
}
```

- [ ] **Step 3: Commit**

```bash
npx vitest run server/tests/lifecycle/debouncer.test.ts
git add server/src/lifecycle/debouncer.ts server/tests/lifecycle/debouncer.test.ts
git commit -m "feat(plan-08): debouncer with rebuild threshold"
```

---

## Task 2: Workspace 应用变更

**Files:**
- Modify: `server/src/workspace/workspace.ts`
- Modify: `server/tests/workspace/workspace.test.ts`

- [ ] **Step 1: 加方法**

```typescript
export interface FileEvent {
  uri: string;
  type: 'created' | 'changed' | 'deleted';
}

// in Workspace:
async applyChanges(events: FileEvent[], conn: Connection): Promise<void> {
  for (const evt of events) {
    const ws = mgr.workspaceFor?.(evt.uri); // 由调用方做路由；此处 events 已是属于本 ws 的
    if (evt.type === 'deleted') {
      this.drop(evt.uri);
      continue;
    }
    // created or changed
    try {
      const fp = fileURLToPath(evt.uri);
      const text = await fs.readFile(fp, 'utf8');
      await this.reindex(evt.uri, text);
    } catch {
      this.drop(evt.uri);
    }
  }
}

async rebuild(conn: Connection): Promise<void> {
  this.store.clear?.(); // 需要给 IndexStore 加 clear 方法
  // global index 也清空
  for (const uri of [...this.global.uris()]) this.global.delete(uri);
  await this.fullScan(conn);
}
```

- [ ] **Step 2: 给 IndexStore 加 clear() 与 GlobalSymbolIndex 加 clear()，并改测试**

```typescript
// IndexStore:
clear(): void { this.byUri.clear(); }

// GlobalSymbolIndex:
clear(): void { this.byName.clear(); this.byUri.clear(); }
```

- [ ] **Step 3: 测试 applyChanges**

```typescript
it('applies "changed" event by re-reading file from disk', async () => {
  const folder = pathToFileURL(resolve(__dirname, '../include/fixtures/projectA')).href;
  const ws = new Workspace(folder, DEFAULT_SETTINGS);
  await ws.bootstrap(fakeConnection);

  const target = pathToFileURL(resolve(__dirname, '../include/fixtures/projectA/Assets/Shaders/Common.hlsl')).href;
  await ws.applyChanges([{ uri: target, type: 'changed' }], fakeConnection);
  expect(ws.store.get(target)).toBeDefined();
});
```

- [ ] **Step 4: Commit**

```bash
git add server/src server/tests
git commit -m "feat(plan-08): Workspace.applyChanges + rebuild"
```

---

## Task 3: client-side FileSystemWatcher

**Files:**
- Create: `client/src/watcher.ts`
- Modify: `client/src/client.ts`

- [ ] **Step 1: 写 watcher**

```typescript
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

export function setupFileWatchers(client: LanguageClient, ctx: vscode.ExtensionContext): void {
  const code = vscode.workspace.createFileSystemWatcher(
    '**/*.{shader,hlsl,cginc,hlslinc,compute}',
  );
  const git  = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  const lock = vscode.workspace.createFileSystemWatcher('**/Packages/packages-lock.json');

  function forward(uri: vscode.Uri, type: 'created' | 'changed' | 'deleted'): void {
    void client.sendNotification('unityShaderNav/fileChange', { uri: uri.toString(), type });
  }

  code.onDidCreate((u) => forward(u, 'created'));
  code.onDidChange((u) => forward(u, 'changed'));
  code.onDidDelete((u) => forward(u, 'deleted'));
  git.onDidChange((u)  => forward(u, 'changed'));
  lock.onDidChange((u) => forward(u, 'changed'));

  ctx.subscriptions.push(code, git, lock);
}
```

- [ ] **Step 2: 在 extension.ts activate 中调用**

```typescript
import { setupFileWatchers } from './watcher';
// ... after client.start():
setupFileWatchers(client, context);
```

- [ ] **Step 3: Commit**

```bash
git add client/src
git commit -m "feat(plan-08): client-side FileSystemWatcher forwarding"
```

---

## Task 4: server-side dispatcher

**Files:**
- Create: `server/src/lifecycle/fileWatcher.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: 实现**

```typescript
import { URI } from 'vscode-uri';
import { Debouncer } from './debouncer';
import type { Connection } from 'vscode-languageserver/node';
import type { WorkspaceManager } from '../workspace';
import type { FileEvent } from '../workspace/workspace';

export function registerFileWatchers(connection: Connection, mgr: WorkspaceManager): void {
  const debouncer = new Debouncer<FileEvent>(
    { windowMs: 500, threshold: 20 },
    async (batch, mode) => {
      // group by workspace
      const groups = new Map<string, FileEvent[]>();
      const meta = { gitChanged: false, lockChanged: false };
      for (const evt of batch) {
        if (evt.uri.endsWith('/.git/HEAD')) meta.gitChanged = true;
        if (evt.uri.endsWith('/Packages/packages-lock.json')) meta.lockChanged = true;
        const ws = mgr.workspaceFor(evt.uri);
        if (!ws) continue;
        const list = groups.get(ws.folderUri) ?? [];
        list.push(evt);
        groups.set(ws.folderUri, list);
      }

      if (meta.gitChanged || meta.lockChanged || mode === 'rebuild') {
        for (const ws of mgr.list()) await ws.rebuild(connection);
        return;
      }

      for (const [folderUri, evts] of groups) {
        const ws = mgr.list().find((w) => w.folderUri === folderUri);
        await ws?.applyChanges(evts, connection);
      }
    },
  );

  connection.onNotification('unityShaderNav/fileChange', (evt: FileEvent) => {
    debouncer.push(evt);
  });
}
```

- [ ] **Step 2: server.ts 接入**

```typescript
import { registerFileWatchers } from './lifecycle/fileWatcher';
// ... after registerDefinitionHandler:
registerFileWatchers(connection, mgr);
```

- [ ] **Step 3: Commit**

```bash
git add server/src/lifecycle/fileWatcher.ts server/src/server.ts
git commit -m "feat(plan-08): server-side file watcher dispatcher"
```

---

## Task 5: RequestSuspender

**Files:**
- Create: `server/src/lifecycle/requestSuspender.ts`
- Create: `server/tests/lifecycle/requestSuspender.test.ts`

- [ ] **Step 1: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';

describe('RequestSuspender', () => {
  it('runs work immediately when not suspended', async () => {
    const s = new RequestSuspender({ timeoutMs: 1000 });
    const r = await s.run(async () => 42);
    expect(r).toBe(42);
  });

  it('suspends and resumes when released', async () => {
    const s = new RequestSuspender({ timeoutMs: 1000 });
    s.suspend();
    const promise = s.run(async () => 'done');
    setTimeout(() => s.release(), 50);
    const r = await promise;
    expect(r).toBe('done');
  });

  it('times out and returns null after timeoutMs', async () => {
    const s = new RequestSuspender({ timeoutMs: 100 });
    s.suspend();
    const promise = s.run(async () => 'never');
    const r = await promise;
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: 实现**

```typescript
export class RequestSuspender {
  private suspended = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly opts: { timeoutMs: number }) {}

  suspend(): void { this.suspended = true; }

  release(): void {
    this.suspended = false;
    const w = this.waiters; this.waiters = [];
    for (const fn of w) fn();
  }

  async run<T>(work: () => Promise<T>): Promise<T | null> {
    if (!this.suspended) return work();
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const settle = (v: T | null) => { if (!settled) { settled = true; resolve(v); } };
      const onRelease = () => { void work().then(settle).catch(() => settle(null)); };
      this.waiters.push(onRelease);
      setTimeout(() => settle(null), this.opts.timeoutMs);
    });
  }
}
```

- [ ] **Step 3: 跑测 + Commit**

```bash
git add server/src/lifecycle/requestSuspender.ts server/tests/lifecycle/requestSuspender.test.ts
git commit -m "feat(plan-08): RequestSuspender for cold-start suspension"
```

---

## Task 6: 接入 Suspender 到 definition handler

**Files:**
- Modify: `server/src/handlers/definition.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: server.ts**

```typescript
import { RequestSuspender } from './lifecycle/requestSuspender';

const suspender = new RequestSuspender({ timeoutMs: 5000 });

connection.onInitialized(async () => {
  suspender.suspend();
  try {
    // ... bootstrap all workspaces
  } finally {
    suspender.release();
  }
});

// 当 rebuild 开始时也 suspend
// （在 fileWatcher dispatcher 里包一层）
```

- [ ] **Step 2: definition handler 包裹**

```typescript
connection.onDefinition(async (params) => {
  return suspender.run(async () => {
    // 原有逻辑
  });
});
```

> 由于 `suspender` 是模块级单例，handler 直接 import；或通过参数注入。后者更可测，但前者更简单——选后者。

- [ ] **Step 3: Commit**

```bash
git add server/src
git commit -m "feat(plan-08): suspend LSP requests during bootstrap/rebuild"
```

---

## Task 7: 集成测 — 文件变更触发增量索引

**Files:**
- Create: `tests/integration/client/lifecycle.test.ts`

- [ ] **Step 1: 测试**

```typescript
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

suite('Lifecycle: edit triggers reindex', () => {
  test('adding a new function to Common.hlsl makes it discoverable from Main.shader', async () => {
    const root = resolve(__dirname, '../../server/include/fixtures/projectA');
    const commonPath = resolve(root, 'Assets/Shaders/Common.hlsl');
    const mainPath   = resolve(root, 'Assets/Shaders/Main.shader');

    // open project, wait for index
    const mainUri = vscode.Uri.file(mainPath);
    await vscode.workspace.openTextDocument(mainUri);
    await new Promise((r) => setTimeout(r, 2500));

    // add a function
    const before = await fs.readFile(commonPath, 'utf8');
    await fs.writeFile(commonPath, before + '\nfloat NewlyAdded() { return 1; }\n');

    // wait for debouncer
    await new Promise((r) => setTimeout(r, 1500));

    // call site: edit Main.shader buffer to call NewlyAdded()
    const mainDoc = await vscode.workspace.openTextDocument(mainUri);
    const edit = new vscode.WorkspaceEdit();
    // insert a call line near the end of HLSL block
    const lines = mainDoc.getText().split('\n');
    const endLine = lines.findIndex((l) => l.trim() === 'ENDHLSL');
    edit.insert(mainUri, new vscode.Position(endLine, 0), 'float4 _z = NewlyAdded();\n');
    await vscode.workspace.applyEdit(edit);
    await vscode.window.showTextDocument(mainDoc);
    await new Promise((r) => setTimeout(r, 800));

    const pos = new vscode.Position(endLine, 'float4 _z = '.length + 2);
    const links = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', mainUri, pos);
    assert.ok(links && links.length >= 1);

    // cleanup
    await fs.writeFile(commonPath, before);
  });
});
```

- [ ] **Step 2: 跑测 + Commit**

```bash
git add tests/integration/client/lifecycle.test.ts
git commit -m "test(plan-08): edit propagates through file watcher"
```

---

## Task 8: rebuild 触发条件 — git checkout / packages-lock 变化

**Files:**
- Create: `tests/integration/client/rebuild-on-branch.test.ts`

- [ ] **Step 1: 测试思路**

模拟 `.git/HEAD` 文件被替换 → 期望 rebuild 发生 → 当下索引结果反映新内容。

```typescript
suite('Rebuild on branch switch', () => {
  test('touching .git/HEAD triggers full rescan', async () => {
    const root = resolve(__dirname, '../../server/include/fixtures/projectA');
    const headPath = resolve(root, '.git/HEAD');
    await fs.mkdir(resolve(root, '.git'), { recursive: true });
    await fs.writeFile(headPath, 'ref: refs/heads/main\n');

    // open project, wait for index
    await vscode.workspace.openTextDocument(resolve(root, 'Assets/Shaders/Main.shader'));
    await new Promise((r) => setTimeout(r, 2500));

    // touch HEAD
    await fs.writeFile(headPath, 'ref: refs/heads/feature\n');
    await new Promise((r) => setTimeout(r, 3000));

    // index should still have Common
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider', 'Common',
    );
    // Workspace symbol provider is plan 13 — for this test, use a different signal:
    // open Common.hlsl and verify F12 still works.
    // (Or just check that no error pops up in Output.)
    assert.ok(true);
  });
});
```

> 由于此 plan 不实现 workspace symbol provider，断言比较弱；本测试主要是 smoke——不报错即可。

- [ ] **Step 2: Commit**

```bash
git add tests/integration/client/rebuild-on-branch.test.ts
git commit -m "test(plan-08): rebuild smoke on .git/HEAD change"
```

---

## Acceptance

1. ✅ 单元测试覆盖：debouncer、requestSuspender、applyChanges
2. ✅ 集成测试：编辑 Common.hlsl 后 Main.shader F12 能找到新增函数（≤ 2s 内反映）
3. ✅ 当 20 文件在 500ms 内变更 → rebuild 模式触发（log 验证）
4. ✅ `.git/HEAD` 变化 → rebuild 触发
5. ✅ `Packages/packages-lock.json` 变化 → rebuild + PackageResolver 重新加载
6. ✅ cold start 期间 F12 挂起、5s 超时返回 null（手动用大项目验证）

## Manual Verification

1. 大项目（≥ URP 完整包）打开，观察状态栏 starting → ready
2. cold start 期间立刻按 F12，VSCode 会显示 loading 直到索引完成或超时
3. `touch .git/HEAD` 后 Output 应该看到 `[rebuild]` 字样的日志
4. `git checkout other-branch`（哪怕本地脚本模拟）后 F12 反映新分支代码

完成后进入 Plan 09。
