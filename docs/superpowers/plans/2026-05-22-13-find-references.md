# Plan 13: Find References 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `textDocument/references`（Shift+F12）。默认范围是 user files（不含 Packages），通过配置 `unityShaderNav.findReferences.includePackages` 切换。Spec §10 Case 13、14。

**Architecture:**
- `GlobalReferenceIndex`：lazy 构建的 `Map<name, ReferenceEntry[]>`。每个 `FileIndex.upsert/delete` 时增量更新；查询时直接 `lookup(name)`。
- 过滤：根据 reference 所在文件是否属于 Packages（physical path 落在 `packageResolver.allPaths()` 之一）决定是否纳入。
- 入口：`textDocument/references` handler。在用户当前位置上，先 `wordAt` 拿名字，再决定它是"全局符号引用"还是"成员引用"（plan 11 链路推导得到 parentType + name 才能精确匹配 struct member 引用）。MVP 只做"按 name 全局匹配"——多候选 Peek 一并解决（ADR-0001）。

**Tech Stack:** 既有。

**Dependencies:** Plan 01-07（11 可选）。

---

## File Structure

新建：
```
server/src/index/globalReferences.ts
server/src/handlers/references.ts

server/tests/index/globalReferences.test.ts
tests/integration/client/find-references.test.ts
```

修改：
- `server/src/workspace/workspace.ts` — Workspace 持有 `globalRefs`；`reindex` / `drop` 同步更新
- `server/src/connection.ts` — capability `referencesProvider: true`
- `server/src/server.ts` — 注册 handler
- `client/package.json` — 已声明 `findReferences.includePackages`（Plan 05）

---

## Task 1: GlobalReferenceIndex

**Files:**
- Create: `server/src/index/globalReferences.ts`
- Create: `server/tests/index/globalReferences.test.ts`

- [x] **Step 1: 实现 + 测试**

```typescript
import type { FileIndex, ReferenceEntry } from '@unity-shader-nav/shared';

export class GlobalReferenceIndex {
  private readonly byName = new Map<string, ReferenceEntry[]>();
  private readonly byUri  = new Map<string, ReferenceEntry[]>();

  upsert(file: FileIndex): void {
    this.delete(file.uri);
    for (const ref of file.references) {
      const arr = this.byName.get(ref.name) ?? [];
      arr.push(ref);
      this.byName.set(ref.name, arr);
    }
    this.byUri.set(file.uri, file.references.slice());
  }

  delete(uri: string): void {
    const prev = this.byUri.get(uri);
    if (!prev) return;
    for (const ref of prev) {
      const arr = this.byName.get(ref.name);
      if (!arr) continue;
      const next = arr.filter((r) => r.location.uri !== uri);
      if (next.length === 0) this.byName.delete(ref.name);
      else this.byName.set(ref.name, next);
    }
    this.byUri.delete(uri);
  }

  lookup(name: string): ReferenceEntry[] {
    return this.byName.get(name)?.slice() ?? [];
  }

  clear(): void { this.byName.clear(); this.byUri.clear(); }
}
```

测试：

```typescript
describe('GlobalReferenceIndex', () => {
  it('aggregates references across files', () => {
    const g = new GlobalReferenceIndex();
    g.upsert({
      uri: 'file:///a.hlsl', symbols: [], references: [
        { name: 'foo', context: 'call', location: { uri: 'file:///a.hlsl', range: { start:{line:1,character:0}, end:{line:1,character:3} } } },
      ],
    });
    g.upsert({
      uri: 'file:///b.hlsl', symbols: [], references: [
        { name: 'foo', context: 'call', location: { uri: 'file:///b.hlsl', range: { start:{line:2,character:0}, end:{line:2,character:3} } } },
      ],
    });
    expect(g.lookup('foo')).toHaveLength(2);
  });

  it('clears previous file entries on upsert', () => {
    const g = new GlobalReferenceIndex();
    g.upsert({ uri: 'file:///a.hlsl', symbols: [], references: [
      { name: 'x', context: 'identifier', location: { uri:'file:///a.hlsl', range:{start:{line:0,character:0},end:{line:0,character:1}} } },
    ] });
    g.upsert({ uri: 'file:///a.hlsl', symbols: [], references: [] });
    expect(g.lookup('x')).toEqual([]);
  });
});
```

- [x] **Step 2: Commit**

```bash
git add server/src/index/globalReferences.ts server/tests/index/globalReferences.test.ts
git commit -m "feat(plan-13): GlobalReferenceIndex"
```

---

## Task 2: Workspace 集成

**Files:**
- Modify: `server/src/workspace/workspace.ts`

- [x] **Step 1: 加字段**

```typescript
import { GlobalReferenceIndex } from '../index/globalReferences';

export class Workspace {
  readonly globalRefs = new GlobalReferenceIndex();
  // ...
}
```

修改 `reindex`、`drop`、`rebuild`、`bootstrapFromCache` 等所有 mutate global symbol 的地方：

```typescript
async reindex(uri, text) {
  const idx = await indexFile(uri, text, this.table);
  this.store.set(uri, idx);
  this.global.upsert(idx);
  this.globalRefs.upsert(idx);
}

drop(uri) {
  this.store.delete(uri);
  this.global.delete(uri);
  this.globalRefs.delete(uri);
}
```

> 同样修改 bootstrapFromCache 中的 `this.global.upsert(idx)` 旁边加 `this.globalRefs.upsert(idx)`。

- [x] **Step 2: 判断 reference 是否属于 Packages**

> Note: 实施时沿用 `Workspace.isWithinPath()` 做 normalized path containment，而不是字符串拼接 `path + '/'`。原因是仓库在 Windows 下运行，file URL 转换后的路径使用平台分隔符并且大小写语义需要跟既有 include/package resolver 保持一致。

```typescript
isInPackages(uri: string): boolean {
  if (!this.packageResolver) return false;
  try {
    const fp = fileURLToPath(uri);
    for (const { path } of this.packageResolver.allPaths()) {
      if (fp.startsWith(path + '/') || fp === path) return true;
    }
  } catch {}
  return false;
}
```

- [x] **Step 3: Commit**

```bash
git add server/src/workspace/workspace.ts
git commit -m "feat(plan-13): Workspace tracks GlobalReferenceIndex"
```

---

## Task 3: references handler

**Files:**
- Create: `server/src/handlers/references.ts`
- Modify: `server/src/connection.ts`
- Modify: `server/src/server.ts`

> Note: 当前实现已在 Plan 10 之后把 request handlers 统一接入 `RequestSuspender` 和 `WorkspaceManager.workspaceForOrCreateFile()`，以支持冷启动/重建挂起和 standalone lazy workspace。Task 3 实施时 references handler 按这个现有生命周期实现为 async handler，而不是照原示例使用同步 `workspaceFor()`。

- [x] **Step 1: handler**

```typescript
import type { Connection, TextDocuments, ReferenceParams, Location } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { WorkspaceManager } from '../workspace';
import { wordAt } from '../index';

export function registerReferencesHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  mgr: WorkspaceManager,
  getIncludePackages: () => boolean,
): void {
  connection.onReferences((params: ReferenceParams): Location[] | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const ws = mgr.workspaceFor(params.textDocument.uri);
    if (!ws) return null;

    const word = wordAt(doc.getText(), params.position);
    if (!word) return null;

    const refs = ws.globalRefs.lookup(word.text);
    const includePkgs = getIncludePackages();
    const symbolsAsRefs = params.context?.includeDeclaration
      ? ws.global.lookup(word.text).map((s) => ({ uri: s.location.uri, range: s.location.range }))
      : [];

    return [
      ...symbolsAsRefs,
      ...refs
        .filter((r) => includePkgs || !ws.isInPackages(r.location.uri))
        .map((r) => ({ uri: r.location.uri, range: r.location.range })),
    ];
  });
}
```

- [x] **Step 2: capability**

```typescript
referencesProvider: true,
```

- [x] **Step 3: server.ts**

```typescript
let settingsRef: ExtensionSettings = DEFAULT_SETTINGS;
onSettingsChanged(connection, async (s) => { settingsRef = s; /* + rebuild */ });

registerReferencesHandler(connection, documents, mgr, () => settingsRef.findReferences.includePackages);
```

- [ ] **Step 4: Commit**

```bash
git add server/src
git commit -m "feat(plan-13): references handler with includePackages toggle"
```

---

## Task 4: 集成测

**Files:**
- Create: `tests/integration/client/fixtures/refs/Lib.hlsl`
- Create: `tests/integration/client/fixtures/refs/Use1.hlsl`
- Create: `tests/integration/client/fixtures/refs/Use2.hlsl`
- Create: `tests/integration/client/find-references.test.ts`

- [ ] **Step 1: fixture**

`Lib.hlsl`:
```hlsl
float Helper(float x) { return x * 2.0; }
```

`Use1.hlsl`:
```hlsl
#include "Lib.hlsl"
float a(float x) { return Helper(x); }
```

`Use2.hlsl`:
```hlsl
#include "Lib.hlsl"
float b(float x) { return Helper(x + 1); }
```

- [ ] **Step 2: 测试**

```typescript
suite('Find References', () => {
  test('Shift+F12 on Helper returns both Use1 and Use2', async () => {
    const fp = path.resolve(__dirname, 'fixtures/refs/Lib.hlsl');
    const uri = vscode.Uri.file(fp);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 1500));

    const line = 0;
    const col = doc.lineAt(line).text.indexOf('Helper') + 2;
    const pos = new vscode.Position(line, col);

    const refs = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider', uri, pos,
    );
    assert.ok(refs && refs.length >= 2);
    const paths = refs.map((r) => r.uri.fsPath);
    assert.ok(paths.some((p) => p.endsWith('Use1.hlsl')));
    assert.ok(paths.some((p) => p.endsWith('Use2.hlsl')));
  });
});
```

- [ ] **Step 3: 测试 Packages 开关**

```typescript
test('Packages references are excluded by default and included with config flag', async () => {
  // 假设 fixture projectA 中有 Core() 在 Main.shader 里被调用
  // 默认 includePackages=false：只列 user files 中的引用
  // 修改配置后再次查询：列表里增加 Packages 的引用

  // 先改 config：
  await vscode.workspace.getConfiguration().update(
    'unityShaderNav.findReferences.includePackages', false, vscode.ConfigurationTarget.Workspace,
  );
  await new Promise((r) => setTimeout(r, 500));

  // ... query references on Core in Packages/Core.hlsl
  // assert: no result OR only includes user files

  await vscode.workspace.getConfiguration().update(
    'unityShaderNav.findReferences.includePackages', true, vscode.ConfigurationTarget.Workspace,
  );
  await new Promise((r) => setTimeout(r, 800));

  // ... re-query
  // assert: more results
});
```

- [ ] **Step 4: Commit**

```bash
npm test
git add tests/integration/client
git commit -m "test(plan-13): Find References e2e + includePackages toggle"
```

---

## Task 5: 文档与最终验收

**Files:**
- Modify: `README.md` — 列出全部功能 + 配置项
- Optional: 在 `docs/superpowers/plans/README.md` 末尾标记完成

- [ ] **Step 1: 写 README**

```markdown
# UnityShaderNav

VSCode 扩展，为 Unity Shader 文件（ShaderLab + HLSL）提供代码导航。

## 功能（MVP + P1）

- F12 跳转：函数 / 变量 / 参数 / 局部变量 / `#include` 路径 / `#pragma vertex|fragment|kernel` 入口
- 多候选 Peek：同名符号在多个 #ifdef 分支 / Pass / overload 时全部列出
- struct 成员 chain lookup（L1-L3）
- `#define` F12 跳转
- Ctrl+Shift+O 文档大纲
- Shift+F12 Find References（默认 user files；可选包含 Packages）

## 配置项

详见 `unityShaderNav.*` 设置项。

## 限制（设计意图，不修复）

- 不评估 `#ifdef` 条件
- 不展开宏（除白名单声明宏 / 引用宏外）
- 不支持 ShaderGraph 生成代码
- 不支持 Surface Shader 隐式参数
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(plan-13): README with MVP + P1 feature list"
```

---

## Acceptance

1. ✅ 单测：GlobalReferenceIndex
2. ✅ 集成测试：Find References 跨文件列出全部引用
3. ✅ Spec §10 **Case 13**：Shift+F12 在用户文件函数上 → 列出 user files 范围内引用
4. ✅ Spec §10 **Case 14**：配置 `includePackages: true` → 列表新增 Packages 引用
5. ✅ `context.includeDeclaration === true` 时 references 列表里包含定义位置

## Manual Verification

1. F5 → 打开多个互相引用的 .hlsl
2. Shift+F12 在某函数定义上 → VSCode 引用面板列出所有调用点
3. 改 settings：`"unityShaderNav.findReferences.includePackages": true` → 再次 Shift+F12 → 列表多出 Packages 下的位置

完成 → MVP + P1 全部交付。
