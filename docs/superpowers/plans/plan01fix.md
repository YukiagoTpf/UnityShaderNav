# Plan 01 Fix 实施计划

> **For agentic workers:** 这不是新功能 plan，是对 Plan 01 已落地代码的修订。基于 `docs/superpowers/plans/plan01review.md` 的 5 个 finding + PROGRESS.md 的 follow-up 重叠项。每个 Task 修一类问题，commit 单独提交。

**Goal:** 把 Plan 01 从"能本地跑、不能发布"修到"可以打包成 VSIX 安装后激活、tests 真正校验 activation events、按 monorepo 标准把 workspace tests 内聚到各 workspace 子目录、clean 脚本跨平台"。

**Architecture 变更点：**
- Server bundle 进入 `client/out/server.js`，让 VSIX 包自带 LSP 服务进程，不再依赖 `../server/out` 相对路径
- workspace 构建顺序固化为 shared → server → client，client 的 build 末尾 copy 一次 server 输出
- vitest 单测内聚到 `server/tests/`，移出 `tests/server/`；`tests/` 顶级目录只留 test-electron 集成测和共享 fixture
- `.vscodeignore` 从 monorepo 根移到 `client/`，让 `vsce package` 在 client/ 目录跑得动

**Dependencies:** Plan 01 / Plan 02（影响 Plan 02 已落地的 4 个 test 文件位置）。

---

## File Structure 变更

```
unity-shader-nav/
├── package.json                          # workspaces 顺序改为 [shared, server, client]; clean 用 rimraf
├── .vscodeignore                         # [删除] 移到 client/.vscodeignore
├── scripts/
│   ├── build.mjs                         # esbuild 把 server bundle 输出到 client/out/server.js
│   └── copy-server.mjs                   # [新增] tsc 路径下 copy server/out/server.js → client/out/
├── client/
│   ├── .vscodeignore                     # [新增] vsce 从 client/ 跑时的排除规则
│   ├── package.json                      # 加 publisher=Yukiago; build 链接 copy-server
│   └── src/client.ts                     # 服务端解析改 context.asAbsolutePath('out/server.js')
├── server/
│   ├── package.json                      # test 脚本去掉 --root ..；vitest 默认 cwd 发现
│   └── tests/                            # [新增] 接收 tests/server/* 搬迁内容
│       ├── handshake.test.ts
│       └── parser/
│           └── shaderlab/
│               ├── blockScanner.test.ts
│               ├── blockScanner.perf.test.ts
│               ├── structureScanner.test.ts
│               └── fixtures/
│                   └── (7 个 .shader fixture)
└── tests/
    ├── client/                            # 保留：test-electron 集成测
    ├── tsconfig.json                      # 保留（仍用于 client suite）
    ├── runTest.ts
    └── fixtures/01-scaffolding/empty-workspace/
    └── (tests/server/ 删除)
```

随之 plan 02/03/06/10/12 文档里的 `tests/server/...` 路径全部改写为 `server/tests/...`。

---

## Task 1: P1 — Bundle server into client package

**问题**：`client/package.json` 是 VSCode extension manifest，`vsce package` 默认从 `client/` 打包。但 `client/src/client.ts` 用 `context.asAbsolutePath('..', 'server', 'out', 'server.js')` 解析 server 入口 —— VSIX 安装后 `client/` 外层目录不存在，server 永远找不到。

**Files:**
- Modify: `unity-shader-nav/package.json`（workspace 顺序）
- Modify: `unity-shader-nav/scripts/build.mjs`（server 输出到 `client/out/server.js`）
- Create: `unity-shader-nav/scripts/copy-server.mjs`（tsc 路径下的 copy 步骤）
- Modify: `unity-shader-nav/client/package.json`（build 链接 copy）
- Modify: `unity-shader-nav/client/src/client.ts`（解析路径改成 `out/server.js`）
- Move/Modify: `unity-shader-nav/.vscodeignore` → `unity-shader-nav/client/.vscodeignore`

- [ ] **Step 1: 顶层 package.json workspaces 顺序固化 `[shared, server, client]`**

`npm run build --workspaces` 按 workspaces 数组顺序跑。client build 末尾要 copy server 产物，所以 server 必须先 build 完。

- [ ] **Step 2: 写 `scripts/copy-server.mjs`**

```javascript
// Copy the tsc-built server bundle (and its sourcemap) into client/out so a
// packaged VSIX rooted at client/ can find it via context.asAbsolutePath('out/server.js').
import { copyFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(monorepoRoot, 'server/out/server.js');
const fromMap = resolve(monorepoRoot, 'server/out/server.js.map');
const to = resolve(monorepoRoot, 'client/out/server.js');
const toMap = resolve(monorepoRoot, 'client/out/server.js.map');

try { await access(from); }
catch { throw new Error(`copy-server: missing ${from} — did the server workspace build first?`); }

await mkdir(dirname(to), { recursive: true });
await copyFile(from, to);
try { await copyFile(fromMap, toMap); } catch { /* sourcemap optional */ }
console.log(`[copy-server] ${from} → ${to}`);
```

- [ ] **Step 3: client 的 build 脚本接 copy**

`client/package.json` 的 build 改为 `"build": "tsc -p . && node ../scripts/copy-server.mjs"`。watch 不动（开发态需要的话另起 chokidar，超出本 fix 范围）。

- [ ] **Step 4: 调整 `scripts/build.mjs`（esbuild 路径）**

`server` entry 的 outfile 从 `server/out/server.js` 改成 `client/out/server.js`。esbuild 路径与 tsc+copy 路径就一致了。

- [ ] **Step 5: 改 `client/src/client.ts` 的服务端模块解析**

```typescript
const serverModule = context.asAbsolutePath(path.join('out', 'server.js'));
```

- [ ] **Step 6: 把 `.vscodeignore` 搬到 `client/`**

monorepo 根的 `.vscodeignore` 不再有作用。新建 `client/.vscodeignore`：

```
**/*.ts
**/*.map
tsconfig*.json
src/**
```

`vsce` 从 `client/` 跑时会按此排除 `.ts`、sourcemap、tsconfig、源码目录；保留 `out/*.js`、`language-configuration/`、`package.json`。

- [ ] **Step 7: 验证**

```bash
cd unity-shader-nav
npm run build            # 期望 shared→server→client 顺序跑通；client/out/server.js 出现
ls client/out/server.js  # 必须存在
npm test                 # 全过
```

- [ ] **Step 8: Commit**

```bash
git add unity-shader-nav/package.json unity-shader-nav/scripts unity-shader-nav/client unity-shader-nav/.vscodeignore
git commit -m "fix(plan-01): bundle server into client/out for VSIX packaging"
```

---

## Task 2: P2-A — Activation 测试不再绕过 activationEvents

**问题**：当前 activation 测试显式 `ext.activate()`，绕过了它声称要测的 `onLanguage:shaderlab` 事件。如果 manifest 的 activationEvents 写错或被删，测试仍 PASS。

**Files:**
- Modify: `unity-shader-nav/tests/client/activation.test.ts`

- [ ] **Step 1: 重写测试 —— 改 poll 模式**

把唯一一个测试拆成两段：(a) manifest 声明静态校验，(b) 实际 onLanguage 触发观察。

```typescript
import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXT_NAME = 'unity-shader-nav';

function findExt(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.all.find((e) => e.packageJSON?.name === EXT_NAME);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

suite('UnityShaderNav activation', () => {
  test('manifest declares onLanguage activation for shaderlab and hlsl', () => {
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');
    const events: string[] = ext.packageJSON.activationEvents ?? [];
    assert.ok(
      events.includes('onLanguage:shaderlab'),
      `expected onLanguage:shaderlab in activationEvents, got ${JSON.stringify(events)}`,
    );
    assert.ok(
      events.includes('onLanguage:hlsl'),
      `expected onLanguage:hlsl in activationEvents, got ${JSON.stringify(events)}`,
    );
  });

  test('opening a .shader document triggers activation via activationEvents', async () => {
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');

    // Open the shader doc without calling ext.activate() — rely on the
    // declared onLanguage:shaderlab event to drive activation.
    const doc = await vscode.workspace.openTextDocument({
      language: 'shaderlab',
      content: 'Shader "Foo" { }',
    });
    await vscode.window.showTextDocument(doc);

    const activated = await waitFor(() => ext.isActive === true);
    assert.strictEqual(
      activated, true,
      'expected onLanguage:shaderlab to activate the extension within 5s',
    );
  });
});
```

> **Note for future plans**：如果之后想覆盖"`.hlsl` 也触发激活"，单进程 Mocha 里第一个 `.shader` 测试已经让扩展进入 active 状态，后面再开 `.hlsl` 观察不到激活事件，只能通过 manifest 静态校验保证。当前两个测试已经覆盖到 review P2 要求的两个语言 id。

- [ ] **Step 2: 验证**

```bash
cd unity-shader-nav
npm test    # mocha 这一段应有 2 个 case 通过
```

- [ ] **Step 3: Commit**

```bash
git add unity-shader-nav/tests/client/activation.test.ts
git commit -m "fix(plan-01): activation test polls isActive instead of manual activate"
```

---

## Task 3: P2-B — 添加 publisher，切回 canonical extension id

**问题**：`client/package.json` 缺 `publisher`，VSCode 全 canonical id 都用 `<publisher>.<name>` 形式；当前测试用 `extensions.all.find(packageJSON.name === ...)` 是开发兜底，不可持续。Publisher 决定：**Yukiago**（与 git author 一致；后续可改 marketplace publisher）。

**Files:**
- Modify: `unity-shader-nav/client/package.json`
- Modify: `unity-shader-nav/tests/client/activation.test.ts`

- [ ] **Step 1: client/package.json 加 publisher**

```json
{
  "name": "unity-shader-nav",
  "publisher": "Yukiago",
  ...
}
```

- [ ] **Step 2: 测试切回 canonical getExtension**

替换 Task 2 写好的 `findExt()`：

```typescript
const EXT_ID = 'Yukiago.unity-shader-nav';

function findExt(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.getExtension(EXT_ID);
}
```

`EXT_NAME` 常量删除，all 扫描分支不再需要。

- [ ] **Step 3: 验证**

```bash
cd unity-shader-nav
npm test    # 期望 mocha 2 case 仍过；vitest 不受影响
```

- [ ] **Step 4: Commit**

```bash
git add unity-shader-nav/client/package.json unity-shader-nav/tests/client/activation.test.ts
git commit -m "fix(plan-01): add publisher and switch tests to canonical extension id"
```

---

## Task 4: P2-C — 把 server 单测搬到 server/tests/

**问题**：当前 server 的 vitest 跑 `--root .. tests/server`，会扫整个 monorepo tests/server/ 下所有 plan 的 spec。Plan 03+ 的 in-flight 失败会把 Plan 01 server workspace 测试拉下水。

**Files:**
- Move (git mv): `unity-shader-nav/tests/server/` → `unity-shader-nav/server/tests/`
- Modify: 移动后所有 test 文件的 import 相对路径（`../../../../server/src/...` → `../../src/...`）
- Modify: `unity-shader-nav/server/package.json`（test 脚本）
- Modify: `unity-shader-nav/server/tsconfig.json`（exclude tests dir 避免 composite 把测试也编进 out/）
- Modify: plan 文档 02 / 03 / 06 / 10 / 12 里所有 `tests/server/...` 路径 → `server/tests/...`

- [ ] **Step 1: git mv 文件**

```bash
cd unity-shader-nav
git mv tests/server server/tests
```

预期：
- `server/tests/handshake.test.ts`
- `server/tests/parser/shaderlab/{blockScanner,blockScanner.perf,structureScanner}.test.ts`
- `server/tests/parser/shaderlab/fixtures/*.shader`（7 个）

- [ ] **Step 2: 改 import 路径**

每个测试文件相对 server src 的层级少了两级（原来 `tests/server/parser/shaderlab/blockScanner.test.ts` 到 `server/src/parser/shaderlab/blockScanner.ts` 是 `../../../../server/src/parser/shaderlab/blockScanner`，移动后变 `../../../src/parser/shaderlab/blockScanner`）。

具体改动：
- `server/tests/handshake.test.ts`：`../../server/src/connection` → `../src/connection`
- `server/tests/parser/shaderlab/blockScanner.test.ts`：`../../../../server/src/parser/shaderlab/blockScanner` → `../../../src/parser/shaderlab/blockScanner`
- `server/tests/parser/shaderlab/blockScanner.perf.test.ts`：同上
- `server/tests/parser/shaderlab/structureScanner.test.ts`：同上 + 同时引用 structureScanner

- [ ] **Step 3: server/package.json test 脚本简化**

```json
"test": "vitest run"
```

去掉 `--root .. tests/server`。vitest 默认 cwd 发现就够。

- [ ] **Step 4: server/tsconfig.json 排除 tests/**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "out",
    "composite": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests/**/*"],
  "references": [{ "path": "../shared" }]
}
```

`exclude` 关键：composite project 默认会把 include 范围内的 .ts 都视为输出源；测试目录虽然不在 src/ 下，但加 exclude 是 defensive。

- [ ] **Step 5: 更新 plan 02/03/06/10/12 文档**

把所有 `tests/server/` 路径替换为 `server/tests/`。涉及：
- Plan 02：File Structure + 多处 fixture / test 路径
- Plan 03：File Structure + 多处 fixture / test 路径
- Plan 06：File Structure + 多处 fixture / test 路径
- Plan 10：File Structure + 多处 fixture / test 路径
- Plan 12：File Structure + 多处 fixture / test 路径

每个 plan 的 import 范例路径里也要相应缩两级（`../../../../server/src/...` → `../../../src/...`）。

- [ ] **Step 6: 验证**

```bash
cd unity-shader-nav
npm run build           # 期望仍全过；server 的 tsc 现在排除 tests
npm test                # vitest 应仍能跑 12 个 case（4 test files）；test-electron 应仍跑 2 个 mocha case
```

- [ ] **Step 7: Commit**

```bash
git add unity-shader-nav/server unity-shader-nav/tests docs/superpowers/plans
git commit -m "fix(plan-01): move server vitest suite into server/tests/ workspace"
```

---

## Task 5: P3 — clean 脚本跨平台

**问题**：`rm -rf` 在 Windows cmd 默认 shell 下不可用。本地 Win 环境 + CI 都可能挂。

**Files:**
- Modify: `unity-shader-nav/package.json`

- [ ] **Step 1: 装 rimraf**

```bash
cd unity-shader-nav
npm install -D rimraf
```

- [ ] **Step 2: 改 clean 脚本**

```json
"clean": "rimraf client/out server/out shared/out"
```

- [ ] **Step 3: 跑一次确认能用**

```bash
npm run clean
ls client/out 2>&1   # 应报 ENOENT 或目录消失
npm run build        # 重建一次确认 build 链没被弄坏
npm test             # 确认仍全过
```

- [ ] **Step 4: Commit**

```bash
git add unity-shader-nav/package.json unity-shader-nav/package-lock.json
git commit -m "fix(plan-01): use rimraf for cross-platform clean script"
```

---

## Acceptance

完成本计划的判定标准：

1. ✅ `npm run build` 全 workspace 零错；`unity-shader-nav/client/out/server.js` 存在（VSIX 即可携 server）
2. ✅ `npm test` 全过：mocha 2 case（manifest 校验 + onLanguage:shaderlab 真激活观察）+ vitest 12 case（不变）
3. ✅ `vsce package`（从 `unity-shader-nav/client/` 下跑）生成的 .vsix 安装后能激活并 spawn server（**手动验证**，CI 暂不覆盖）
4. ✅ `npm run clean` 在 Win cmd / PowerShell / bash 任何一种下都能跑
5. ✅ 5 Task 各一 commit；plan 02/03/06/10/12 文档中所有 `tests/server/` 引用已替换

## Manual Verification

1. 跑 `cd unity-shader-nav && npm run clean && npm run build && npm test`，全程零错
2. 跑 `cd unity-shader-nav/client && npx vsce package --no-dependencies --no-yarn`（需要先 `npm install -D @vscode/vsce`），产物 `.vsix` 中确认含 `out/extension.js` + `out/server.js`
3. （可选）`code --install-extension <path>.vsix` 后重启 VSCode，打开 `.shader` 文件，确认状态栏出现 `UnityShaderNav: ready`

完成后回到 PROGRESS.md 更新 Plan 01 状态为"Done (after fix)"，清掉 follow-up TODO 里的 publisher 与 vitest --root 两条。
