# Plan 01: Project Scaffolding 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 UnityShaderNav 的 TypeScript monorepo 骨架——VSCode 扩展端 + LSP 服务进程；扩展可在 VSCode 中激活、注册 5 种 Unity Shader 文件类型、与服务端完成 LSP initialize 握手并返回一个 trivial 的 `Hello from server`；测试基础设施（vitest、@vscode/test-electron）就位。

**Architecture:** 采用 `client + server` 两进程模式。`client/` 是 VSCode 扩展，负责注册激活事件、加载 LSP 客户端、把状态显示到 Status Bar；`server/` 是独立 Node 子进程，使用 `vscode-languageserver` SDK，启动后只回 capabilities。`shared/` 仅放公共 TypeScript 类型，编译产物互不依赖。

**Tech Stack:** TypeScript 5.x、Node 18+（VSCode 内嵌 Electron 的 Node 版本）、`vscode-languageclient` ^9、`vscode-languageserver` ^9、`vscode-languageserver-textdocument` ^1、`vitest` ^1、`@vscode/test-electron` ^2、`@vscode/vsce` ^2、`esbuild`（打包）。

**Dependencies:** 无（这是第一个计划）。

---

## File Structure

新建：

```
unity-shader-nav/
├── package.json                          # 顶层 workspace 声明
├── tsconfig.base.json                    # 共享 tsconfig 基线
├── .vscode/
│   ├── launch.json                       # F5 调试配置
│   └── settings.json                     # 推荐扩展、formatter
├── .vscodeignore                         # vsce 打包排除规则
├── .gitignore                            # 追加 node_modules, dist, out
├── client/
│   ├── package.json                      # 扩展 manifest（含 contributes）
│   ├── tsconfig.json
│   ├── src/
│   │   ├── extension.ts                  # 激活入口
│   │   ├── statusBar.ts                  # 状态栏组件
│   │   └── client.ts                     # LSP 客户端启动
│   └── language-configuration/
│       ├── shader.json                   # ShaderLab 语言配置（注释/括号）
│       └── hlsl.json                     # HLSL 语言配置
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts                     # LSP 入口
│       └── connection.ts                 # connection 单例与 capability 注册
├── shared/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── protocol.ts                   # 占位的 extension-specific 协议
├── tests/
│   ├── tsconfig.json                    # 编译 tests/ 自身（Mocha runner + runTest 引导）
│   ├── runTest.ts                       # @vscode/test-electron 引导入口（含 launchArgs）
│   ├── client/
│   │   ├── activation.test.ts            # @vscode/test-electron 集成测
│   │   └── suite/
│   │       └── index.ts                  # Mocha runner（test-electron 进程内执行）
│   ├── server/
│   │   └── handshake.test.ts             # vitest 单元测
│   └── fixtures/
│       └── 01-scaffolding/
│           └── empty-workspace/
│               └── .gitkeep
└── scripts/
    └── build.mjs                         # esbuild 打包脚本
```

修改：无（顶层暂无源码）。

每个文件的职责单一：`client/src/extension.ts` 只负责 activate/deactivate 调度，所有"创建 client"逻辑下沉到 `client/src/client.ts`，"状态栏"下沉到 `client/src/statusBar.ts`。服务端把 `connection` 单例隔离到 `server/src/connection.ts`，方便后续 handler 复用。

---

## Task 1: 顶层 workspace 与共享 tsconfig

**Files:**
- Create: `unity-shader-nav/package.json`
- Create: `unity-shader-nav/tsconfig.base.json`
- Create: `unity-shader-nav/.gitignore`

- [ ] **Step 1: 在仓库根创建子目录 `unity-shader-nav/` 并 cd 进入**

```bash
mkdir -p unity-shader-nav && cd unity-shader-nav
```

预期：目录创建成功，无报错。

- [ ] **Step 2: 写顶层 `package.json`**

```json
{
  "name": "unity-shader-nav-monorepo",
  "private": true,
  "version": "0.0.1",
  "workspaces": ["client", "server", "shared"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "watch": "npm run watch --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "clean": "rm -rf client/out server/out shared/out"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^18.19.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 3: 写 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 4: 写 `.gitignore`**

```
node_modules/
*/out/
*/dist/
.vscode-test/
*.vsix
```

- [ ] **Step 5: 跑 `npm install` 装顶层依赖**

```bash
npm install
```

预期：装上 TypeScript，无 ERR。`node_modules/` 出现。`npm ls typescript` 显示 5.x。

- [ ] **Step 6: Commit**

```bash
git add unity-shader-nav/package.json unity-shader-nav/tsconfig.base.json unity-shader-nav/.gitignore
git commit -m "chore(plan-01): bootstrap TS workspace skeleton"
```

---

## Task 2: shared 包占位

**Files:**
- Create: `unity-shader-nav/shared/package.json`
- Create: `unity-shader-nav/shared/tsconfig.json`
- Create: `unity-shader-nav/shared/src/protocol.ts`

- [ ] **Step 1: 写 `shared/package.json`**

```json
{
  "name": "@unity-shader-nav/shared",
  "version": "0.0.1",
  "private": true,
  "main": "out/protocol.js",
  "types": "out/protocol.d.ts",
  "scripts": {
    "build": "tsc -p .",
    "watch": "tsc -p . -w"
  }
}
```

- [ ] **Step 2: 写 `shared/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "out",
    "composite": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: 写 `shared/src/protocol.ts`（占位常量）**

```typescript
export const EXTENSION_ID = 'unity-shader-nav';
export const SERVER_NAME = 'UnityShaderNav Language Server';
```

- [ ] **Step 4: build 通过**

```bash
npm run build -w @unity-shader-nav/shared
```

预期：`shared/out/protocol.js` 与 `.d.ts` 生成；无报错。

- [ ] **Step 5: Commit**

```bash
git add unity-shader-nav/shared
git commit -m "chore(plan-01): add shared package with protocol constants"
```

---

## Task 3: server 包与 LSP 握手

**Files:**
- Create: `unity-shader-nav/server/package.json`
- Create: `unity-shader-nav/server/tsconfig.json`
- Create: `unity-shader-nav/server/src/connection.ts`
- Create: `unity-shader-nav/server/src/server.ts`

- [ ] **Step 1: 写 `server/package.json`**

```json
{
  "name": "@unity-shader-nav/server",
  "version": "0.0.1",
  "private": true,
  "main": "out/server.js",
  "scripts": {
    "build": "tsc -p .",
    "watch": "tsc -p . -w",
    "test": "vitest run --root .. tests/server"
  },
  "dependencies": {
    "@unity-shader-nav/shared": "0.0.1",
    "vscode-languageserver": "^9.0.1",
    "vscode-languageserver-textdocument": "^1.0.11"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: 写 `server/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "out",
    "composite": true
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 3: 写失败测试 `tests/server/handshake.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { createInitializeResult } from '../../server/src/connection';

describe('LSP handshake', () => {
  it('returns text document sync incremental + serverInfo', () => {
    const result = createInitializeResult();
    expect(result.serverInfo?.name).toBe('UnityShaderNav Language Server');
    expect(result.capabilities.textDocumentSync).toBeDefined();
  });
});
```

- [ ] **Step 4: 在 server 目录初始化 vitest 配置并跑失败**

```bash
npm install -w @unity-shader-nav/server
cd server && npx vitest run --root . ../tests/server/handshake.test.ts
```

预期：FAIL，`createInitializeResult is not a function`（或模块找不到）。

- [ ] **Step 5: 写最小实现 `server/src/connection.ts`**

> **Note:** `createConnection` 被包成 lazy getter，避免在 vitest 单元测试 import 时立刻去抓 stdin/IPC（unit test 上下文里没有 LSP transport 参数，会抛 `Connection input stream is not set`）。`server.ts` 第一次访问 `connection` 时才真正建连接。

```typescript
import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  type Connection,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { SERVER_NAME } from '@unity-shader-nav/shared';

let _connection: Connection | undefined;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = createConnection(ProposedFeatures.all);
  }
  return _connection;
}

export function createInitializeResult(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
    serverInfo: {
      name: SERVER_NAME,
      version: '0.0.1',
    },
  };
}
```

- [ ] **Step 6: 写 `server/src/server.ts`**

```typescript
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getConnection, createInitializeResult } from './connection';

const connection = getConnection();
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => createInitializeResult());

connection.onInitialized(() => {
  connection.console.log('[UnityShaderNav] server initialized');
});

documents.listen(connection);
connection.listen();
```

- [ ] **Step 7: 跑测试和编译都通过**

```bash
npm run build -w @unity-shader-nav/server
npx vitest run --root . tests/server/handshake.test.ts
```

预期：build OK，test PASS。

- [ ] **Step 8: Commit**

```bash
git add unity-shader-nav/server unity-shader-nav/tests/server
git commit -m "feat(plan-01): server skeleton with initialize handshake"
```

---

## Task 4: client 扩展 manifest 与激活逻辑

**Files:**
- Create: `unity-shader-nav/client/package.json`
- Create: `unity-shader-nav/client/tsconfig.json`
- Create: `unity-shader-nav/client/src/extension.ts`
- Create: `unity-shader-nav/client/src/client.ts`
- Create: `unity-shader-nav/client/src/statusBar.ts`
- Create: `unity-shader-nav/client/language-configuration/shader.json`
- Create: `unity-shader-nav/client/language-configuration/hlsl.json`

- [ ] **Step 1: 写 `client/package.json`（含 VSCode 扩展 manifest）**

```json
{
  "name": "unity-shader-nav",
  "displayName": "UnityShaderNav",
  "description": "Code navigation for Unity Shader files (ShaderLab + HLSL).",
  "version": "0.0.1",
  "private": true,
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Programming Languages"],
  "main": "./out/extension.js",
  "activationEvents": [
    "onLanguage:shaderlab",
    "onLanguage:hlsl"
  ],
  "contributes": {
    "languages": [
      {
        "id": "shaderlab",
        "aliases": ["ShaderLab", "Unity Shader"],
        "extensions": [".shader"],
        "configuration": "./language-configuration/shader.json"
      },
      {
        "id": "hlsl",
        "aliases": ["HLSL", "Unity HLSL"],
        "extensions": [".hlsl", ".cginc", ".hlslinc", ".compute"],
        "configuration": "./language-configuration/hlsl.json"
      }
    ]
  },
  "scripts": {
    "build": "tsc -p .",
    "watch": "tsc -p . -w"
  },
  "dependencies": {
    "@unity-shader-nav/shared": "0.0.1",
    "vscode-languageclient": "^9.0.1"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0"
  }
}
```

- [ ] **Step 2: 写 `client/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "out",
    "composite": true
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 3: 写 `client/language-configuration/shader.json`**

```json
{
  "comments": { "lineComment": "//", "blockComment": ["/*", "*/"] },
  "brackets": [["{", "}"], ["[", "]"], ["(", ")"]],
  "autoClosingPairs": [
    { "open": "{", "close": "}" },
    { "open": "[", "close": "]" },
    { "open": "(", "close": ")" },
    { "open": "\"", "close": "\"" }
  ]
}
```

- [ ] **Step 4: 写 `client/language-configuration/hlsl.json`**（结构同上，可复用配置）

```json
{
  "comments": { "lineComment": "//", "blockComment": ["/*", "*/"] },
  "brackets": [["{", "}"], ["[", "]"], ["(", ")"]],
  "autoClosingPairs": [
    { "open": "{", "close": "}" },
    { "open": "[", "close": "]" },
    { "open": "(", "close": ")" },
    { "open": "\"", "close": "\"" }
  ]
}
```

- [ ] **Step 5: 写 `client/src/statusBar.ts`**

```typescript
import * as vscode from 'vscode';

export type StatusMode = 'starting' | 'ready' | 'standalone' | 'error';

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.set('starting');
    this.item.show();
  }

  set(mode: StatusMode, detail?: string): void {
    const labels: Record<StatusMode, string> = {
      starting: 'UnityShaderNav: starting…',
      ready: 'UnityShaderNav: ready',
      standalone: 'UnityShaderNav: standalone mode',
      error: 'UnityShaderNav: error',
    };
    this.item.text = labels[mode] + (detail ? ` (${detail})` : '');
  }

  dispose(): void {
    this.item.dispose();
  }
}
```

- [ ] **Step 6: 写 `client/src/client.ts`**

```typescript
import * as path from 'node:path';
import { ExtensionContext } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

export function createLanguageClient(context: ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(
    path.join('..', 'server', 'out', 'server.js'),
  );

  const serverOptions: ServerOptions = {
    run:   { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'shaderlab' },
      { scheme: 'file', language: 'hlsl' },
    ],
    synchronize: {},
  };

  return new LanguageClient(
    'unityShaderNav',
    'UnityShaderNav',
    serverOptions,
    clientOptions,
  );
}
```

- [ ] **Step 7: 写 `client/src/extension.ts`**

```typescript
import { ExtensionContext } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { createLanguageClient } from './client';
import { StatusBar } from './statusBar';

let client: LanguageClient | undefined;
let statusBar: StatusBar | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  statusBar = new StatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  client = createLanguageClient(context);
  await client.start();
  statusBar.set('ready');
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
```

- [ ] **Step 8: 装依赖并 build 通过**

```bash
npm install -w unity-shader-nav
npm run build -w unity-shader-nav
```

预期：`client/out/extension.js` 生成；无 TS 报错。

- [ ] **Step 9: Commit**

```bash
git add unity-shader-nav/client
git commit -m "feat(plan-01): extension client with LSP boot and status bar"
```

---

## Task 5: launch.json + 调试入口

**Files:**
- Create: `unity-shader-nav/.vscode/launch.json`
- Create: `unity-shader-nav/.vscode/settings.json`

- [ ] **Step 1: 写 `.vscode/launch.json`**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "runtimeExecutable": "${execPath}",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}/client"],
      "outFiles": ["${workspaceFolder}/client/out/**/*.js"],
      "preLaunchTask": "npm: build"
    },
    {
      "name": "Attach to Server",
      "type": "node",
      "request": "attach",
      "port": 6009,
      "restart": true,
      "outFiles": ["${workspaceFolder}/server/out/**/*.js"]
    }
  ],
  "compounds": [
    {
      "name": "Client + Server",
      "configurations": ["Run Extension", "Attach to Server"]
    }
  ]
}
```

- [ ] **Step 2: 写 `.vscode/settings.json`**

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "editor.formatOnSave": true
}
```

- [ ] **Step 3: 手动验证 F5**

在 VSCode 中打开 `unity-shader-nav/` 文件夹，按 F5。

预期：
1. 弹出新的"Extension Development Host" 窗口
2. 状态栏右下出现 `UnityShaderNav: ready`
3. Output panel → "UnityShaderNav" 频道有 `[UnityShaderNav] server initialized`

（如果开发机没有 GUI，本步骤记为"手动验证"，CI 替代见 Task 6。）

- [ ] **Step 4: Commit**

```bash
git add unity-shader-nav/.vscode
git commit -m "chore(plan-01): launch config for F5 dev cycle"
```

---

## Task 6: 集成测试 — 扩展激活与握手

**Files:**
- Create: `unity-shader-nav/tests/client/activation.test.ts`
- Modify: `unity-shader-nav/client/package.json` (devDependency `@vscode/test-electron`)
- Create: `unity-shader-nav/tests/runTest.ts`

- [ ] **Step 1: 装 `@vscode/test-electron`**

```bash
npm install -D -w unity-shader-nav @vscode/test-electron mocha @types/mocha
```

- [ ] **Step 2: 写失败测试 `tests/client/activation.test.ts`**

> **Note:** 由于 `client/package.json` 还没有声明 `publisher` 字段，`vscode.extensions.getExtension('unity-shader-nav')` 不会命中（VSCode 内部需要 `publisher.name` 形式的 id；development host 下会回退为 `undefined_publisher.unity-shader-nav`）。所以这里改成扫描 `vscode.extensions.all`，按 `packageJSON.name` 匹配。

```typescript
import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('UnityShaderNav activation', () => {
  test('extension activates on .shader open', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'shaderlab',
      content: 'Shader "Foo" { }',
    });
    await vscode.window.showTextDocument(doc);

    const ext = vscode.extensions.all.find(
      (e) => e.packageJSON?.name === 'unity-shader-nav',
    );
    assert.ok(ext, 'extension manifest must be loaded');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });
});
```

- [ ] **Step 3: 写 `tests/runTest.ts`（test-electron 引导）**

`launchArgs` 必须显式传 fixture workspace 目录，否则 test-electron 启动的 Extension Development Host 没有 workspace folder，Plan 04+ 的 `WorkspaceManager` 拿不到任何 folder，集成测试全返回 null。fixture 路径从 `USN_TEST_FIXTURE` 环境变量读，未设置时退化为 Plan 01 的 `empty-workspace`。

> **Path note:** 编译产物在 `tests/out/runTest.js`，所以 `__dirname` = `tests/out`。monorepo root = `path.resolve(__dirname, '../..')`。

```typescript
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // __dirname at runtime = unity-shader-nav/tests/out
  const monorepoRoot = path.resolve(__dirname, '../..');
  const extensionDevelopmentPath = path.resolve(monorepoRoot, 'client');
  const extensionTestsPath = path.resolve(__dirname, './client/suite');

  const fixtureRel = process.env.USN_TEST_FIXTURE
    ?? 'tests/fixtures/01-scaffolding/empty-workspace';
  const workspaceFolder = path.resolve(monorepoRoot, fixtureRel);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspaceFolder, '--disable-extensions'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

> **后续 plan 注意**：Plan 04 / 05 / 06 / 07 / 10 / 11 / 13 的集成测试 npm script 必须设置 `USN_TEST_FIXTURE=<本 plan 的 fixture 目录>` 后再调 `node tests/out/runTest.js`，否则 test-electron 启在错误的 workspace 下。

- [ ] **Step 4: 写 `tests/client/suite/index.ts`（Mocha runner）**

```typescript
import * as path from 'node:path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
  const testsRoot = path.resolve(__dirname, '..');
  const files = await glob('**/*.test.js', { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} failed`)) : resolve()));
  });
}
```

- [ ] **Step 5: 写 `tests/tsconfig.json`**

tests/ 不属于任何 workspace 子包，要单独有一份 tsconfig，把 `tests/*.ts`、`tests/client/**/*.ts` 编译到 `tests/out/`。注意打开 `composite: false` 避免与 client/server 的 project references 冲突。

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "out",
    "composite": false,
    "module": "CommonJS",
    "moduleResolution": "Node",
    "types": ["node", "mocha"]
  },
  "include": ["runTest.ts", "client/**/*.ts"],
  "exclude": ["server/**/*", "out/**"]
}
```

- [ ] **Step 6: 跑测试**

```bash
npm run build -w unity-shader-nav
npx tsc -p tests/tsconfig.json   # 编译 tests/ → tests/out/
node tests/out/runTest.js
```

预期：测试启动 Electron，激活扩展，PASS。第一次跑会下载 VSCode test binary。

- [ ] **Step 7: 把 `npm test` 接入顶层**

修改顶层 `package.json` 的 `scripts.test`：

```json
"test": "npm run build && tsc -p tests/tsconfig.json && node tests/out/runTest.js && npm run test --workspaces --if-present"
```

- [ ] **Step 8: Commit**

```bash
git add unity-shader-nav/tests
git commit -m "test(plan-01): activation integration test with test-electron"
```

---

## Task 7: esbuild 打包脚本（可选发行准备）

**Files:**
- Create: `unity-shader-nav/scripts/build.mjs`
- Create: `unity-shader-nav/.vscodeignore`

- [ ] **Step 1: 写 `scripts/build.mjs`（client/server 同时 bundle）**

```javascript
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  format: 'cjs',
};

await build({ ...common, entryPoints: ['client/src/extension.ts'], outfile: 'client/out/extension.js' });
await build({ ...common, entryPoints: ['server/src/server.ts'],    outfile: 'server/out/server.js'    });

console.log('bundle done');
```

- [ ] **Step 2: 装 esbuild**

> **Note:** `unity-shader-nav-monorepo` 是 root package（不是 workspace 子包），用 `-w` 会报 `No workspaces found`。直接装到 root devDeps：

```bash
npm install -D esbuild
```

- [ ] **Step 3: 写 `.vscodeignore`**

```
**/*.ts
**/tsconfig*.json
tests/**
.vscode/**
scripts/**
node_modules/**/test/**
```

- [ ] **Step 4: 跑打包**

```bash
node scripts/build.mjs
```

预期：`client/out/extension.js` 与 `server/out/server.js` 都生成；无报错。

- [ ] **Step 5: Commit**

```bash
git add unity-shader-nav/scripts unity-shader-nav/.vscodeignore
git commit -m "chore(plan-01): esbuild bundle script"
```

---

## Acceptance

完成本计划的判定标准：

1. ✅ `npm run build` 在 `unity-shader-nav/` 目录下零报错
2. ✅ `npm test` 全部通过（vitest handshake + test-electron activation）
3. ✅ **Manual Verification**：在 VSCode 里按 F5，Extension Development Host 弹出后：
   - 状态栏出现 `UnityShaderNav: ready`
   - Output → "UnityShaderNav" 频道有 `[UnityShaderNav] server initialized`
   - 创建一个新 `.shader` 文件，语言模式自动识别为 ShaderLab
   - 创建一个新 `.hlsl` 文件，语言模式自动识别为 HLSL
4. ✅ 7 个 Task 的 commit 全部在 git log 中可见

对应 Spec §10 验收用例：无（这是基础设施）。

## Manual Verification

1. `code unity-shader-nav/`
2. 按 F5
3. 新窗口里 `File → New File → 命名 test.shader → 输入 `Shader "X" { SubShader { Pass {} } }`
4. 确认底部状态栏 `UnityShaderNav: ready`
5. 关闭 Extension Development Host

如果以上任一步骤失败，本计划不通过，必须修复后再进入 Plan 02。
