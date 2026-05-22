# UnityShaderNav 实施进度

更新于：2026-05-22。**第一次读这个文件的 agent** 请先看 [CLAUDE.md](../../CLAUDE.md) 了解执行纪律。

## 13 个 Plan 状态总览

| # | Plan | 状态 | Spec §10 验收 | 备注 |
|---|---|---|---|---|
| 01 | project-scaffolding | ✅ Done（5 处偏离已记） | — | F5 manual 待人工 |
| 02 | shaderlab-block-parser | ⏸ Next | — | |
| 03 | hlsl-symbol-collector | ⏸ Blocked by R1 spike | — | tree-sitter-hlsl 节点名需要先验证 |
| 04 | single-file-definition | ⏸ Planned | Case 1, 8 | |
| 05 | macro-pattern-recognizer | ⏸ Planned | Case 5, 6, 7 | |
| 06 | include-resolver | ⏸ Planned | Case 4 | |
| 07 | package-resolver-and-cross-file | ⏸ Planned | Case 2, 3, 9 | MVP 完成点 |
| 08 | index-lifecycle | ⏸ P1 | — | |
| 09 | cache-persistence | ⏸ P1 | — | |
| 10 | document-symbols | ⏸ P1 | Case 12 | |
| 11 | chain-lookup | ⏸ P1 | Case 10 | L3b 已标 P2（B4 修订） |
| 12 | macro-definitions | ⏸ P1 | Case 11 | |
| 13 | find-references | ⏸ P1 | Case 13, 14 | |

依赖：01 → 02 → 03 → 04 → {05, 06} → 07 → {08, 09, 10, 11, 12, 13}。

## Plan 01 实施记录

**Commits**：`657ec18..d76c4a8`（7 个 Task 各一 commit）

| Task | 状态 | Commit |
|---|---|---|
| 1 顶层 workspace + tsconfig | ✅ | `657ec18` |
| 2 shared 包占位 | ✅ | `45577b3` |
| 3 server 包 + handshake | ✅（偏离 1）| `9f52ae7` |
| 4 client 扩展 + 状态栏 | ✅ | `349a4f2` |
| 5 launch.json | ✅ | `19ead6f` |
| 6 集成测 (test-electron) | ✅（偏离 2/3/4）| `c4e7c11` |
| 7 esbuild 打包 | ✅（偏离 5）| `d76c4a8` |

**Plan 与现实的 5 处偏离**（已在 plan markdown 内用 `> Note:` 标注）：

1. **server/src/connection.ts** 改成 lazy `getConnection()` — `createConnection()` 在模块加载期抓 IPC，vitest 单测无 transport 会抛 `Connection input stream is not set`
2. **tests/runTest.ts** 显式从 `__dirname (= tests/out)` 反推 `monorepoRoot = ../..` — 原 plan 的 `path.resolve(__dirname, '../client')` 编译后会指向 `tests/client`
3. **activation.test.ts** 用 `vscode.extensions.all.find(...)` 而不是 `getExtension('unity-shader-nav')` — client/package.json 无 `publisher` 字段，VSCode 期望 `publisher.name` 形式 ID
4. **server vitest script** 加 `--root .. tests/server` — cwd=server/ 默认不会发现 tests/server/ 下的 spec
5. **esbuild 装到 root devDeps** 不带 `-w` flag — `unity-shader-nav-monorepo` 是 workspace root 不是成员

**主 agent 验证结果**（2026-05-22）：
- `npm run build`：3 个 workspace tsc 全过，零 warning
- `npm test`：vitest 1/1 + test-electron 1/1 全 PASS（cold start ~1.4s）

**Codex 独立 review**：尝试两次均被 Windows sandbox 拦截（`exit -1`），未拿到第二意见。session `019e4fb0-565d-7c22-92c2-94c1e3ed556b` 可用 `! codex resume <id>` 在原生 CLI 续跑。

## 进行中 TODO

### 🟡 Plan 01 follow-up（不阻塞 Plan 02，但要在 Plan 13 publish 前清掉）

- **client/package.json 加 `publisher` 字段**：当前 activation 测试用 `extensions.all.find(packageJSON.name === ...)` workaround，marketplace 发布前必须补 publisher 才能用 canonical `getExtension('publisher.name')`，VSCode 部分 API（command routing, extension dependency）也走 `publisher.name` 形式 ID
- **`vitest --root ..` 跨 workspace 扫描**：现在只有 server 一处 vitest 不会撞，但 Plan 02+ 在 server 加 `tests/server/parser/` 类 spec 时，从 server workspace 跑 vitest 会扫到整个 monorepo。建议在 Plan 02 把 server-side tests 内联到 `server/tests/`
- **`.vscode-test/` 体积**：test-electron 会下载 ~200MB 完整 VSCode（已 gitignore）。CI 上每次冷启动需要 cache key 或预下载

### 🔴 Plan 03 前置（必须先做）

- **R1 spike — tree-sitter-hlsl 节点名验证**：Plan 03 假设的节点名（`function_definition` / `field_identifier` / etc.）是猜的，wasm 实际 `node-types.json` 里可能叫别的。开 Plan 03 前花 30 分钟：
  1. `git clone https://github.com/tree-sitter-grammars/tree-sitter-hlsl && npx tree-sitter build --wasm`
  2. 20 行 Node 脚本 parse 典型 HLSL，打 `tree.rootNode.toString()`
  3. 拿真实节点名 patch 回 Plan 03 collector 代码

### ⏸ 待手动验证

- **Plan 01 F5 验证**（在 GUI 环境）：
  1. 在 VSCode 打开 `unity-shader-nav/` 文件夹按 F5
  2. 新 Extension Development Host 状态栏出现 `UnityShaderNav: ready`
  3. Output 频道 "UnityShaderNav" 有 `[UnityShaderNav] server initialized`
  4. 新建 `.shader` / `.hlsl` 文件，语言模式正确识别

### ⏳ 已展望的风险（来自 REVIEW，未排进 Blocker）

- **R6/R7/R8**：性能并发模型 — cold start 串行 `fs.stat()`、persist 全量重写、`fullScan()` 无 bounded concurrency。Plan 07/08/09 前要补 concurrency model 段落
- **R3**：Plan 10 buildDocumentSymbols 嵌套算法 fiddly，TDD 时小心
- **R5**：Plan 06 `existsCaseSensitive` 在 macOS 上语义反了；macOS CI 会爆
- **P3**：Plan 08 `this.store.clear?.()` 用 optional chaining 兜底，但 `IndexStore.clear()` 没正式定义 — Plan 07/08 落地时补

## 下一步

1. 决策点：在 Plan 02 之前**先做 R1 spike** 还是**先跑 Plan 02**？Plan 02 是纯 ShaderLab 块扫描，不依赖 tree-sitter，可以独立完成；但 Plan 03 必须等 R1。建议：派 subagent 并行——Plan 02 实施 + R1 spike 单独跑。
2. Plan 02 完成后接 Plan 03，按 R1 spike 拿到的真实节点名调整 collector。

## 历史回放（review 修订）

- 2026-05-22：13 个 plan 文档 + 1 份 REVIEW（10🔴 / 9🟡 / 7🟢）落库
- 2026-05-22：10 Blocker 全部修订（commit `04e5140..406a4f5`，分 8 个 thematic commit）
- 2026-05-22：Plan 01 实施（commit `657ec18..d76c4a8`，分 7 个 task commit）
