# UnityShaderNav 实施进度

更新于：2026-05-23。**第一次读这个文件的 agent** 请先看 [CLAUDE.md](../../CLAUDE.md) 了解执行纪律。

## 13 个 Plan 状态总览

| # | Plan | 状态 | Spec §10 验收 | 备注 |
|---|---|---|---|---|
| 01 | project-scaffolding | ✅ Done + plan01fix 应用 | — | F5 manual 待人工；vsix 打包路径已修正 |
| 02 | shaderlab-block-parser | ✅ Done + plan02fix 应用 | — | sanitizer 接管字符串/注释；scanStructure 加 range 覆盖 |
| 03 | hlsl-symbol-collector | ✅ Done + review fixes applied | — | R1 spike 完成；cbuffer 走 fallback；type refs / top-level globals covered |
| 04 | single-file-definition | ✅ Done + review fixes applied | Case 1, 8 | 单文件 F12 已接入 LSP；含参数 F12、多候选、proximity |
| 05 | macro-pattern-recognizer | ✅ Done + review fixes applied | Case 5, 6, 7 | macro declarations + pragma refs；custom setting reindex covered |
| 06 | include-resolver | ✅ Done + review fix applied | Case 4 | include path F12 + refs；case fallback；block comment false positive fixed |
| 07 | package-resolver-and-cross-file | ✅ Done + review fixes applied | Case 2, 3, 9 | MVP 完成 |
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

## Plan 02 实施记录

**Commits**：`302756b..840c05c`（8 个 Task 各一 commit）

| Task | 状态 | Commit |
|---|---|---|
| 1 类型定义（in shared） | ✅ | `302756b` |
| 2 单 Pass fixture + 最小 blockScanner | ✅ | `34606dd` |
| 3 多 Pass + HLSLINCLUDE | ✅ | `429eaff` |
| 4 CG 兼容 + 注释/字符串干扰 | ✅ | `e96b4bc` |
| 5 嵌套大括号 + 未闭合块 | ✅ | `bec8560` |
| 6 structureScanner | ✅ | `87a5dce` |
| 7 块扫描 ↔ 结构扫描 交叉验证 | ✅ | `7736a01` |
| 8 性能 smoke | ✅ | `840c05c` |

**Plan 与现实偏离**：**0 处**。subagent 全部照抄 plan markdown 的代码片段和命令。

**主 agent 验证结果**（2026-05-22）：
- `npm run build`：3 个 workspace tsc 全过
- `npm test`：vitest 4 test files / 12 cases 全过（8 blockScanner + 2 structureScanner + 1 perf + 1 handshake）+ test-electron activation 1/1
- 性能 smoke：1000 块合成 .shader 实测 0.34~1.11ms（threshold 50ms，~100x 余量）
- 类型契约：`shared/src/protocol.ts` 通过 `export * from './structure';` re-export `ShaderLabBlock` / `ShaderLabStructureNode` / `StructureResult` 等。server 端 `blockScanner.ts` / `structureScanner.ts` 都 `import from '@unity-shader-nav/shared'`，符合 B3 修订意图

**新建文件**：
- `shared/src/structure.ts`
- `server/src/parser/shaderlab/{blockScanner,structureScanner,index}.ts`
- `tests/server/parser/shaderlab/{blockScanner,structureScanner,blockScanner.perf}.test.ts`
- `tests/server/parser/shaderlab/fixtures/{single-pass,multi-pass,hlslinclude-with-passes,cg-legacy,mixed-comments,nested-braces,unterminated-block}.shader`

> **Note (plan01fix Task 4 之后)**：以上 `tests/server/parser/...` 路径已迁移到 `server/tests/parser/...`，且 commit 范围 `302756b..840c05c` 的实际文件位置因为 `git mv` 已经更新（不影响这些 commit 的 SHA）。

## Plan 01 Fix 实施记录

源自 `docs/superpowers/plans/plan01review.md`（用户写的 P1/P2/P3 review）+ 本 PROGRESS.md 之前 follow-up 重叠项。**Commits**：`6658479..ada540b`（plan doc + 5 个 Task commit）。

| Task | 修的问题 | 状态 | Commit |
|---|---|---|---|
| 0 | plan01fix.md + plan01review.md 入库 | ✅ | `6658479` |
| 1 | P1: bundle server 进 client/out（VSIX 打包） | ✅ | `82a2044` |
| 2 | P2-A: 删 ext.activate()，改 poll；加 manifest 静态校验 | ✅ | `3833553` |
| 3 | P2-B: 添加 publisher="Yukiago"，切回 canonical id | ✅ | `1b72dc9` |
| 4 | P2-C: tests/server → server/tests + 同步 13 个 plan 路径 | ✅ | `789adb9` |
| 5 | P3: rm -rf → rimraf，clean 顺手扫 tsbuildinfo | ✅ | `ada540b` |

**主 agent 验证结果**（2026-05-22）：
- `npm run clean && npm run build && npm test` 端到端 PASS
- `client/out/server/server.js` 存在（VSIX 安装路径就绪）
- vitest 12/12（4 test files：handshake + blockScanner + structureScanner + perf）
- mocha 2/2（manifest 静态校验 + onLanguage:shaderlab 事件触发观察）
- activation 测试现在真测 `activationEvents` 配置 —— 之前是手动 `ext.activate()` 假阳性
- server 的 vitest cwd 落在 server workspace，不会再扫到 Plan 03+ 的 in-flight 失败
- `npm run clean` 在 Win cmd / Git Bash 都可用，并清掉 `*.tsbuildinfo` 避免 stale incremental cache

## Plan 02 Fix 实施记录

源自 `docs/superpowers/plans/plan02review.md`（用户写的 P1/P2 review，4 个 finding）。**Commits**：`93f00ae..7d48312`（plan doc + 5 个 Task commit）。

| Task | 修的问题 | 状态 | Commit |
|---|---|---|---|
| 0 | plan02fix.md + plan02review.md 入库 | ✅ | `93f00ae` |
| 1 | 新增 sanitizeLine 基础设施（共享 //, /* */, string 处理） | ✅ | `9f422f6` |
| 2 | P1#1: scanStructure brace 计数被字符串里的 `}` 误终止 | ✅ | `25f55ed` |
| 3 | P2#1: scanBlocks 不识别 directive 行后的 `/* */` | ✅ | `9b1ed3a` |
| 4 | P1#2: `Pass { Name "X" }` 紧凑写法没填 `node.name` | ✅ | `2271ef4` |
| 5 | P2#2: structureScanner 范围断言加强（4 新 case） | ✅ | `7d48312` |

**关键设计决策（实施中修订）**：
- 最初 sanitizer 把字符串内容全部屏蔽（commit `9f422f6`）。但跑 structureScanner 原有测试时发现，`SHADER_RE = /^\s*Shader\s+"([^"]*)"/` 要从字符串里捕 shader 名，全屏蔽会让它捕到空字符串。Task 2 (commit `25f55ed`) 重新定义 sanitizer：字符串内**只屏蔽结构性字符 `{` `}`**，其他字符保留。这样 regex name capture 和 brace 计数共用同一份 sanitized 输出，不需要双 pass。plan02fix.md 已同步更新这个设计。

**主 agent 验证结果**（2026-05-22）：
- `npm run clean && npm run build && npm test` 端到端 PASS
- vitest **27/27**（sanitize 8 + handshake 1 + blockScanner 9 + structureScanner 8 + perf 1）
- mocha **2/2** 不变
- 性能 smoke 仍 < 50ms（sanitizer 单趟 O(n)，对原 perf 几乎无影响）

**Plan 10 依赖锁定**：
- `ShaderLabStructureNode.headerLine` 和 `.closeLine` 现在被 4 个新 case 明确断言（single-pass / multi-subshader / unterminated / block-comment-between-tokens）。Plan 10 用这些字段做 Document Symbols 树时不会再因 string/comment 边缘 case 出错。

## 与 plan01fix 的协调（事后核对）

plan02fix 没碰任何 plan01fix 已建立的约定：
- 测试落 `server/tests/parser/shaderlab/`（plan01fix Task 4 拓扑）✓
- 类型在 `shared/src/structure.ts`，无新 server-local types ✓
- workspaces 顺序 / build chain / publisher / `.vscodeignore` 不动 ✓
- 跨 plan signature 兼容性不动（plan02fix 不动 indexFile / resolveDefinition 等签名）✓

## Plan 03 实施记录

**Commits**：`bf90337..92616e1`（11 个 commit：10 Task + 1 R1 spike）

| Task | 状态 | Commit |
|---|---|---|
| 1 shared types (SymbolEntry / FileIndex) | ✅ | `bf90337` |
| 2 vendor tree-sitter-hlsl.wasm | ✅ | `41c6aa0` |
| — R1 spike — calibrate node names | ✅ | `c5786a9` |
| 3 parser singleton（createRequire 绕坑） | ✅ | `11219be` |
| 4 node helpers | ✅ | `d07143d` |
| 5 collector — functions + parameters | ✅ | `6433735` |
| 6 collector — struct + cbuffer（fallback） | ✅ | `e00cf4f` |
| 7 collector — locals + shadowing | ✅ | `43192c1` |
| 8 collector — references（call/type/member） | ✅ | `56e33ab` |
| 9 fileIndexer — .shader 多块拼接 | ✅ | `95d2e2e` |
| 10 nested struct fixture | ✅ | `92616e1` |

**R1 Spike 关键发现**（详见 plan markdown §R1 Spike Result 段，对应表 18 行）：

| 项 | 实际情况 |
|---|---|
| 节点名猜对 | `function_definition` / `function_declarator` / `parameter_list` / `parameter_declaration` / `struct_specifier` / `field_declaration_list` / `field_declaration` / `field_identifier` / `call_expression` / `field_expression` / `type_identifier` / `compound_statement` / `declaration` / `init_declarator` |
| 节点名猜错 | `function_declaration` / `cbuffer_declaration` / `init_declaration` / `local_variable_declaration` / `struct_declaration_list`（全不存在） |
| 必须补识 | `primitive_type`（`void`/`float` 等内置类型走这个，不是 `type_identifier`） |
| 最大坑 | **grammar 不识别 `cbuffer`**，把 `cbuffer Foo { ... };` 误析成 `function_definition` —— collector 用 `isCbufferShape()` 启发式识别 (`type.text === 'cbuffer'/'tbuffer'/'ConstantBuffer' && declarator.type === 'identifier'`) |

**实施中的偏离（全部 plan markdown 内联 Note）**：
1. **Task 2 WASM 入库**：上游 v0.2.0 release 无 wasm artifact，fetch 脚本 404 → Docker emcc fallback（clone + `tree-sitter build --wasm` 走 `emscripten/emsdk:3.1.64` 镜像）
2. **Task 3 parser.ts**：web-tree-sitter 0.22 在 `Parser.init()` 内 `module.exports = Module` 重赋值，vite/vitest 的 ESM default import 拿不到后挂出的 `.Language` → 用 `createRequire(__filename)('web-tree-sitter')` lazy require + cache。如果将来升级到 0.23+ 需切回标准 import（已在 plan markdown Note 提醒）。
3. **节点名校准**：见 R1 Spike Result 表，collector 代码段照真实节点名重写
4. **cbuffer fallback**：grammar 不识别 cbuffer，collector 启发式识别
5. **WASM 路径层数**：plan 注释说"从 `out/parser/hlsl` 上推 4 层"，实际 3 层就到 `server/`（plan 代码本身的 `'..','..','..'` 是对的，注释口径错；subagent 选择保留）

**主 agent 验证结果**（2026-05-22）：
- `npm run clean && npm run build`：3 个 workspace tsc + esbuild + copy-server 全过
- `npm test`：mocha **2/2** + vitest **39/39**（baseline 27 → +12：parser 2 + collector 8 + fileIndexer 2）
- 性能：collector + parser 8 个 case 共 28ms，fileIndexer 2 个 case 22ms，无规模问题
- WASM 入库（4.1 MB）；nested struct case 显式断言 `Outer.inner.declaredType === 'Inner'` 和 `Make.returnType === 'Outer'`，Plan 11 chain lookup 所需元数据已就位
- 集成 plan01fix/plan02fix 拓扑：测试在 `server/tests/parser/hlsl/`、shared types 经 `@unity-shader-nav/shared` 出口、indexFile 保留 `_table?: unknown` 槽位（B5 forward-compat）

**Review / fix（补录）**：
- `b4519cf fix(plan-03): address hlsl collector review findings` 已修复 `plan03review.md` 的 3 项：generic identifier refs、copied-server WASM runtime path、多/数组 declarator。
- `docs/superpowers/plans/plan03fix.md` 已记录上述修复；`plan03review.md` 当前仍是未跟踪文件，若要保留 source review 需单独入库。

**Phase 01-05 full review follow-up（2026-05-23）**：
- `docs/superpowers/plans/phase01-05review.md` 落库，复核 `plan03review.md` 旧 finding 已不再成立。
- 新修复：custom type usages 现在产生 `context='type'` references；top-level ordinary HLSL globals 现在进入 `kind='variable'` symbols。
- 新修复：client build 在 copy-server 后运行 esbuild bundle，`client/out/server/server.js` 不再外部依赖 private workspace/shared 或 LSP server packages；`web-tree-sitter` 作为动态加载的 runtime dependency 声明在 client package。
- 验证：`npm test` PASS，test-electron **9/9**，server vitest **19 files / 76 tests**。
- Deferred：`#pragma` reference scanner 仍未处理跨行 `/* ... */` 注释；Plan 13 Find References 前应和 sentinel noise 一并处理。

## Plan 04 实施记录

**Commits**：`02cd114..c9de2ec`（8 个 Task 各一 commit）+ review/fix commits `9b71ab8`, `43aa703` + independent review/doc fix `bb3ff01`, `b7800ec`。

| Task | 状态 | Commit |
|---|---|---|
| 1 wordAt helper | ✅（偏离 1） | `02cd114` |
| 2 IndexStore | ✅（TDD 补测试） | `a882f4e` |
| 3 symbolResolver + proximity | ✅ | `2e1f5d8` |
| 4 TextDocuments -> IndexStore | ✅ | `b4f7e19` |
| 5 definition handler | ✅ | `fa6035d` |
| 6 server wiring + capability | ✅（偏离 2） | `7f9bdd5` |
| 7 in-process F12 smoke | ✅ | `4bc9542` |
| 8 test-electron F12 | ✅（偏离 3/4/5） | `c9de2ec` |

**Review / fix**：
- `docs/superpowers/plans/plan04review.md` 落库：发现 Case 8 端到端覆盖缺口、document open duplicate/stale index 风险
- `docs/superpowers/plans/plan04fix.md` 落库：补 Case 8 in-process + test-electron 覆盖；document sync 改为 change-content 单路索引，并用 live uri + version guard 防 stale async set
- `9b71ab8 fix(plan-04): address definition review findings`
- `43aa703 fix(plan-04): correct parameter F12 integration cursor`
- 独立 code-review subagent 复核 `b4519cf..c18ad49` 后无 blocking implementation finding，仅记录 P3 plan replay 问题：Task 8 focused command `npm test -w unity-shader-nav -- --grep "F12 single-file"` 不可复跑
- `bb3ff01 docs(plans): record plan 04 code review`
- `b7800ec docs(plans): fix plan 04 focused verification command`

**Plan 与现实偏离（全部 plan markdown 内联 Note）**：
1. Task 1：计划实现片段会在 whitespace 上向左吸附 identifier，但测试要求 whitespace/symbol 返回 `null`；实际以测试语义为准
2. Task 6：保留 plan01fix 的 lazy `getConnection()`，没有回退到 eager `createConnection`
3. Task 8：fixture 不会复制到 `tests/out`，integration test 从运行时 out 目录回指源码 fixture
4. Task 8：`tests/tsconfig.json` 原 include 不含 `integration/**/*.ts`，已加入
5. Task 8：mocha suite 原只 glob `tests/out/client`，已提升到 `tests/out` 以执行 integration 测试
6. Task 8：原 focused command 指向无 `test` script 的 client workspace；plan markdown 已加 Note，验收命令改为 monorepo root `npm test`

**主 agent 验证结果**（2026-05-22）：
- `npm test`：端到端 PASS
- test-electron **6/6**：packaged server layout 1 + activation 2 + F12 single-file 3（.hlsl call、.hlsl parameter、multi-pass .shader 2 candidates）
- server vitest **14 files / 58 tests passed**
- Acceptance：Case 1 .shader multi-pass function F12 ✓；Case 8 parameter identifier F12 ✓；multi-candidate links ✓；proximity tie-break ✓

## Plan 05 实施记录

**Commits**：`86176b6..6946b2a`（9 个 Task 各一 commit）+ review/fix commits `58797dc`, `ee26cd4`。

| Task | 状态 | Commit |
|---|---|---|
| 1 shared settings 类型 | ✅ | `86176b6` |
| 2 模式语法 & 解析器 | ✅ | `759afa1` |
| 3 内置模式表 | ✅ | `383af71` |
| 4 MacroPatternTable | ✅ | `6d5ad30` |
| 5 matcher — call_expression → declaration | ✅ | `b59f7d4` |
| 6 matcher — `#pragma` reference patterns | ✅ | `63f99a9` |
| 7 接入 collector + fileIndexer | ✅（偏离 1） | `1591beb` |
| 8 用户配置 pipeline | ✅ | `f24d8d2` |
| 9 test-electron macro F12 | ✅ | `6946b2a` |

**Review / fix**：
- `docs/superpowers/plans/plan05review.md` 落库：发现 settings 动态同步、坏用户 pattern 隔离、CG legacy 非 call declaration、Case 7 F12 覆盖等问题
- `docs/superpowers/plans/plan05fix.md` 落库：修复 config sync + custom macro reindex、坏 user macro skip、`.compute` pragma kernel F12 覆盖；CG legacy 非 call declaration 明确 deferred
- `58797dc docs(plans): record plan 05 code review`
- `ee26cd4 fix(plan-05): address macro recognizer review findings`

**Plan 与现实偏离（已在 plan markdown 内联 Note）**：
1. Task 7：plan 原 focused command `npx vitest run` 从 monorepo root 会扫到 VSCode mocha/test-electron 文件；实际使用 `npm run test -w @unity-shader-nav/server` 做 server vitest 范围验证
2. Fix：`sampler2D $name` / `fixed4 $name` CG legacy declaration 不塞进 call/pragma matcher，已 deferred 到后续非 call declaration support

**主 agent 验证结果**（2026-05-22）：
- `npm run build`：3 个 workspace tsc + copy-server 全过
- `npm run test -w @unity-shader-nav/server`：server vitest **19 files / 74 tests passed**
- `npm test`：test-electron **8/8** + server vitest **74/74** 全过
- Acceptance：Case 5 macro-declared `_MainTex` F12 ✓；Case 6 `#pragma vertex vert` index/ref path ✓；Case 7 `.compute #pragma kernel CSMain` in-process F12 ✓；custom `unityShaderNav.declarationMacros` 动态更新并 reindex 已打开文件 ✓

**遗留风险**：
- CG legacy `sampler2D $name` / `fixed4 $name` 是普通 HLSL declaration，不属于 Plan 05 call/pragma matcher；后续做非 call declaration support 时补
- `CBUFFER_END` / instancing buffer start/end 等 unmatched macro sentinel 目前仍可能作为 references 噪声进入索引，Plan 13 Find References 前建议加 ignored macro/sentinel 策略
- 当前 settings table 是全局实例；fix 为单 workspace 验收增加了 definition 前 scoped refresh。多 root/per-folder settings 需要 Plan 08/09 生命周期设计时统一配置缓存粒度

## Plan 06 实施记录

**Commits**：`d154078..11ce08d`（10 个 Task 各一 commit）+ review/fix commits `750f181`, `5375c40`。

| Task | 状态 | Commit |
|---|---|---|
| 1 lineScanner 扫描 `#include` + range | ✅ | `d154078` |
| 2 include resolver 类型 | ✅（偏离 1） | `39e115b` |
| 3 fixture Unity 项目 | ✅ | `f2c1116` |
| 4 resolver 相对路径优先 | ✅ | `57207dc` |
| 5 Assets fallback + includeDirectories | ✅ | `9169531` |
| 6 大小写 fallback + warning flag | ✅ | `c204500` |
| 7 Unity project root 自动检测 | ✅ | `83af65b` |
| 8 include reference 入库 | ✅ | `998dfed` |
| 9 definition handler include path F12 | ✅ | `2ab92f7` |
| 10 test-electron include F12 | ✅（偏离 2） | `11ce08d` |

**Review / fix**：
- `docs/superpowers/plans/plan06review.md` 落库：code-review subagent 复核无 P1/P2；P3 为 block comment 内 `#include` false positive
- `docs/superpowers/plans/plan06fix.md` 落库：`scanIncludes()` 加 block-comment awareness，保留 pathRange character 稳定性；新增回归测试
- `750f181 docs(plans): record plan 06 code review`
- `5375c40 fix(plan-06): ignore block-commented includes`

**Plan 与现实偏离（已在 plan markdown 内联 Note）**：
1. Task 2：原片段在 `index.ts` 导出尚未存在的 `./resolver`，会让中间提交 TypeScript 断裂；实际先只导出 types，Task 4 创建 resolver 后再补导出
2. Task 10：集成测试编译后运行在 `tests/out/integration/client`，fixture 回指路径实际为 `../../../../server/tests/include/fixtures/projectA`

**主 agent 验证结果**（2026-05-23）：
- `npm run test -w @unity-shader-nav/server -- --run tests/parser/include/lineScanner.test.ts`：scanner focused **3/3** PASS
- `npm run build`：3 个 workspace tsc + copy-server + bundle 全过
- `npm test`：全量端到端 PASS（test-electron **10/10** + server vitest **90/90**）
- Acceptance：Case 4 `#include "Common.hlsl"` F12 ✓；relative / Assets / includeDirectories priority ✓；`Packages/...` Plan 07 前返回 null ✓；case-insensitive fallback returns real path + warning flag ✓；include refs use `context='include'` ✓；block-commented include false positive fixed ✓

**Deferred**：
- `server/src/include/circularGuard.ts` 仍未创建。review 判定不属于 Plan 06 必需项；Plan 08 增量索引处理 include graph 时再落地。

## Plan 07 实施记录

**Commits**：`7dffab7..5b22b34`（11 个 Task 各一 commit）+ review/fix commits `ab4449d`, `310a83b`。

| Task | 状态 | Commit |
|---|---|---|
| 1 lockfile parser | ✅（偏离 1） | `7dffab7` |
| 2 PackageResolver | ✅ | `baccd4e` |
| 3 Packages include resolver 分支 | ✅ | `f5eb4bb` |
| 4 GlobalSymbolIndex | ✅ | `48ed3d9` |
| 5 symbolResolver 全局 fallback | ✅ | `9ca70ad` |
| 6 walkFiles | ✅ | `92ae941` |
| 7 Workspace full scan + global index | ✅ | `b61e831` |
| 8 WorkspaceManager multi-root | ✅ | `0874012` |
| 9 server rewiring to WorkspaceManager | ✅（偏离 2） | `7e23abc` |
| 10 cross-file + multi-root integration | ✅ | `206f3a5` |
| 11 ready/standalone status mode | ✅ | `5b22b34` |

**Review / fix**：
- `docs/superpowers/plans/plan07review.md` 落库：发现 registry lockfile 无 hash、关闭文档删除 full-scan index、`settings.projectRoot` 被忽略、配置变更后新增 workspace 用旧 settings。
- `docs/superpowers/plans/plan07fix.md` 落库：registry 无 hash fallback 到 `<name>@<version>`；full-scan disk index 与 live overlay 分离；`settings.projectRoot` 优先；WorkspaceManager 新增 folder 使用最新 settings。
- `ab4449d docs(plans): record plan 07 code review`
- `310a83b fix(plan-07): address package resolver review findings`

**Plan 与现实偏离（已在 plan markdown 内联 Note）**：
1. Registry package lock entries without `hash` are common in real Unity projects. Original plan treated these as unsupported; implementation now falls back to `Library/PackageCache/<name>@<version>` while keeping git strict (`hash` required, `git+ssh://` / `?path=` still unsupported).
2. Existing test-electron suites open fixture files outside the initial empty workspace, and `updateWorkspaceFolders()` can refuse later additions in the same suite. Implementation adds `WorkspaceManager.workspaceForOrCreateFile()` to lazy-create a Unity/standalone workspace for opened files not owned by any registered root, preserving single-file and external-fixture navigation while keeping multi-root longest-prefix isolation.

**主 agent 验证结果（2026-05-23）**：
- `npm test`：全量端到端 PASS
- test-electron **13/13**：activation/package layout + single-file F12 + macro F12/config reindex + include F12 + cross-file Common/Core + multi-root isolation
- server vitest **29 files / 118 tests** PASS
- Acceptance：Case 2 same-project cross-file `Common()` F12 ✓；Case 3 `Packages/com.example.urp/.../Core()` F12 ✓；Case 9 projectB `OnlyInB()` 不串到 projectA `Common()` ✓；status bar mode notification ready/standalone ✓

**Deferred**：
- `Workspace.fullScan()` 当前通过 `GlobalSymbolIndex.upsert()` 避免同 URI 重复，但配置变更后若 excludePatterns 收紧，不会主动删除此前已扫描但现在被排除的旧文件。Plan 08 index lifecycle 设计中处理 store/global 清理与增量删除。

## 进行中 TODO

### 🟡 Plan 01 follow-up（plan01fix 之后还剩的）

- ~~**client/package.json 加 `publisher` 字段**~~ ✅ 已修复（plan01fix Task 3）
- ~~**`vitest --root ..` 跨 workspace 扫描**~~ ✅ 已修复（plan01fix Task 4）
- **`.vscode-test/` 体积**：test-electron 会下载 ~200MB 完整 VSCode（已 gitignore）。CI 上每次冷启动需要 cache key 或预下载

### 🔴 Plan 03 前置（必须先做）

- ~~**R1 spike — tree-sitter-hlsl 节点名验证**~~ ✅ 已完成（Plan 03 实施开头，commit `c5786a9`），校准表写进 plan markdown

### ⏸ 待手动验证

- **Plan 01 F5 验证**（在 GUI 环境）：
  1. 在 VSCode 打开 `unity-shader-nav/` 文件夹按 F5
  2. 新 Extension Development Host 状态栏出现 `UnityShaderNav: ready`
  3. Output 频道 "UnityShaderNav" 有 `[UnityShaderNav] server initialized`
  4. 新建 `.shader` / `.hlsl` 文件，语言模式正确识别

- **Plan 02 Manual driver**（可选）：plan §Manual Verification 给的 `node /tmp/verify-plan02.mjs <fixture>` 驱动脚本未跑 —— 12 个单测已覆盖所有 fixture 路径，跑驱动只是冗余可视化，可跳过

- **VSIX 手动打包/安装验证**：Phase 01-05 full review 已补 bundle runtime-closure 测试，但尚未实际执行 `vsce package` + 安装后的 GUI smoke。

### ⏳ 已展望的风险（来自 REVIEW，未排进 Blocker）

- **R6/R7/R8**：性能并发模型 — cold start 串行 `fs.stat()`、persist 全量重写、`fullScan()` 无 bounded concurrency。Plan 08/09 前要补 concurrency model 段落
- **R3**：Plan 10 buildDocumentSymbols 嵌套算法 fiddly，TDD 时小心
- ~~**R5**：Plan 06 `existsCaseSensitive` 在 macOS 上语义反了；macOS CI 会爆~~ ✅ Plan 06 实现用逐段 `readdir` 校验真实大小写，并通过显式 ignore-case fallback 返回磁盘真实路径
- **P3**：Plan 08 `this.store.clear?.()` 用 optional chaining 兜底，但 `IndexStore.clear()` 没正式定义 — Plan 07/08 落地时补

## 下一步

1. 进入 **Plan 08: index-lifecycle**，补文件变更触发增量/重建、进度条与挂起处理。
2. Plan 08 前重点确认 full-scan 清理、include graph/circular guard、PackageResolver reload、workspace folder/settings 变化的生命周期边界。

## 历史回放（review 修订）

- 2026-05-22：13 个 plan 文档 + 1 份 REVIEW（10🔴 / 9🟡 / 7🟢）落库
- 2026-05-22：10 Blocker 全部修订（commit `04e5140..406a4f5`，分 8 个 thematic commit）
- 2026-05-22：Plan 01 实施（commit `657ec18..d76c4a8`，7 个 task commit）
- 2026-05-22：CLAUDE.md + PROGRESS.md 落库（commit `618d456`）
- 2026-05-22：Plan 02 实施（commit `302756b..840c05c`，8 个 task commit，0 偏离）
- 2026-05-22：plan01fix 实施（commit `6658479..ada540b`，1 个 plan doc commit + 5 个 task commit，源自用户写的 plan01review.md）
- 2026-05-22：plan02fix 实施（commit `93f00ae..7d48312`，1 个 plan doc commit + 5 个 task commit，源自用户写的 plan02review.md；含 sanitizer 设计的中途修订）
- 2026-05-22：Plan 03 实施 + R1 spike（commit `bf90337..92616e1`，10 个 task commit + 1 个 spike commit，5 处偏离全部 plan markdown 内联记录）
- 2026-05-22：Plan 04 实施 + review/fix（commit `02cd114..b7800ec`，8 个 task commit + 2 个 fix commit + 独立 review/doc fix，6 处偏离全部 plan markdown 内联记录）
- 2026-05-22：Plan 05 实施 + review/fix（commit `86176b6..ee26cd4`，9 个 task commit + review doc + fix commit，Case 5/6/7 覆盖；2 处偏离 plan markdown 内联记录）
- 2026-05-23：Phase 01-05 full review + fixes（`phase01-05review.md`；修 packaged runtime closure、Plan 03 type refs、top-level globals；`npm test` 9/9 + 76/76）
- 2026-05-23：Plan 06 实施 + review/fix（commit `d154078..5375c40`，10 个 task commit + review doc + fix commit，Case 4 覆盖；2 处偏离 plan markdown 内联记录）
- 2026-05-23：Plan 07 实施 + review/fix（commit `7dffab7..310a83b`，11 个 task commit + review doc + fix commit，Case 2/3/9 覆盖；2 处偏离 plan markdown 内联记录；MVP 完成）
