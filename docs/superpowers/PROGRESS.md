# UnityShaderNav 进度快照

更新于：2026-05-25。第一次接手本仓库时先读 [CLAUDE.md](../../CLAUDE.md)，再读本文。

## 当前阶段

项目已经从 13 个 plan 的实施阶段进入真实项目 debug 阶段。

- VSCode extension + LSP MVP 已完成，源码 root 为 `unity-shader-nav/`。
- 13 个 plan 的详细执行记录保留在 [plans/](plans/) 和 git history 中，本文不再重复全量流水。
- 当前主要工作是在 Extension Development Host 中用真实 Unity 项目 `F:\Project\UnityProject\Pandora` 复现并修 F12 / Find References / Outline 的实际体验问题。
- issue tracker 已切到 GitHub Issues；后续 TODO 以 issue 为主，[TODO.md](TODO.md) 只保留入口和阶段性说明。

## 调试方式

源码调试不要反复安装 VSIX。推荐流程：

1. 用 VSCode 打开 `F:\Project\UnityShaderNav\unity-shader-nav`。
2. 在 `unity-shader-nav/` 下执行 `npm run build`。
3. 用 VSCode 的 `Client + Server` 或 `Run Extension` 启动 Extension Development Host。
4. 在 Extension Development Host 中打开真实 Unity 项目 `F:\Project\UnityProject\Pandora`。
5. 修改源码后再次执行 `npm run build`。
6. 在 Extension Development Host 中执行 `Developer: Reload Window`。
7. 需要断点时 attach `Attach to Server`；`launch.json` 已包含实际运行的 `client/out/server/**/*.js`。

Output 面板使用 `UnityShaderNav` channel。当前 `npm run watch` 仍不是完整 runtime watch，这一点已记录为 issue。

## 当前已知真实项目问题

GitHub Issues 是当前 backlog：

| Issue | 主题 | 状态 |
|---|---|---|
| [#1](https://github.com/YukiagoTpf/UnityShaderNav/issues/1) | F12 / References 应按 scope、include chain、canonical target 过滤，避免 name-only 混入其他 shader | Open |
| [#2](https://github.com/YukiagoTpf/UnityShaderNav/issues/2) | struct 类型和成员跳转：`Customdata customdata;`、`i.positionWS` 等 | Open |
| [#3](https://github.com/YukiagoTpf/UnityShaderNav/issues/3) | 大项目索引性能、cache 体积、跨进程 cache 写入硬化 | Closed |
| [#4](https://github.com/YukiagoTpf/UnityShaderNav/issues/4) | CI 缓存 `.vscode-test/` 下载 | Open |
| [#5](https://github.com/YukiagoTpf/UnityShaderNav/issues/5) | `clean` 清理 `tests/out`，避免 stale Electron tests | Open |
| [#6](https://github.com/YukiagoTpf/UnityShaderNav/issues/6) | F5 开发用 runtime watch/dev script | Open |
| [#7](https://github.com/YukiagoTpf/UnityShaderNav/issues/7) | 过滤 Unity macro sentinel references | Closed（未手动验证，后续使用中如复现再 reopen） |
| [#8](https://github.com/YukiagoTpf/UnityShaderNav/issues/8) | CG legacy variable declarations 索引 | Open |
| [#9](https://github.com/YukiagoTpf/UnityShaderNav/issues/9) | Chain lookup L3b/L4：数组、嵌套字段、cbuffer struct、RHS inference | Open |
| [#10](https://github.com/YukiagoTpf/UnityShaderNav/issues/10) | 更多 Unity PackageManager path forms | Open |

## 最近 debug 修复

- `0e77e94 chore(debug): include copied server output in attach config`
  - `Attach to Server` 现在覆盖 `client/out/server/**/*.js`，断点能命中实际运行的 server bundle。
- `b869662 fix(plan-04): resolve definitions at call boundaries`
  - 修复光标落在函数名右边界或 `(` 上时 `wordAt()` 返回 null 的问题。
  - 真实案例：`CharFragmentPBR(` 上 F12 不再提示 no identifier under cursor。
  - 验证：新增 RED/GREEN 回归，focused definition/wordAt tests 18/18，`npm run build` PASS。
- `2647ae6 fix(plan-07): resolve builtin package cache paths`
  - 修复 `source=builtin` 的 Unity packages 未映射到 `Library/PackageCache/<name>@<version>` 的问题。
  - 真实案例：`PerceptualSmoothnessToPerceptualRoughness` 定义位于 `com.unity.render-pipelines.core@14.0.11/ShaderLibrary/CommonMaterial.hlsl`，现在可进入 package resolver / package scan。
  - 验证：package/include focused tests 22/22，server vitest 46 files / 262 tests PASS。
- `3a5fbcc test(issue-2): cover struct type navigation`
  - 为 `Customdata customdata;` 补 same-file、include-chain、`.shader` HLSLPROGRAM 回归覆盖。
  - 验证 type token `Customdata` 跳 struct，variable token `customdata` 仍跳 local variable。
- `cc3defd test(issue-2): cover receiver typed struct member navigation`
  - 为 `inputData.positionWS` 和 `i.positionWS` 补 receiver typed struct member 回归覆盖。
  - 验证：definition handler 17/17，server vitest 46 files / 269 tests PASS，`npm run build` PASS。
- `ce5a1dc fix(plan-04): handle unity struct macro navigation`
  - 修复 `UNITY_VERTEX_INPUT_INSTANCE_ID` / `UNITY_VERTEX_OUTPUT_STEREO` 等无分号 Unity struct 宏导致 tree-sitter 把后续 `frag` 函数体误嵌进 `v2f` 的问题。
  - 真实案例：`Char_Common.shader` 中 `InputData inputData;` 重新被索引为 `frag` local variable，结构体类型跳转恢复。
  - 剩余问题：真实 Extension Host 中 `inputData.positionWS` 这类结构体成员 token 仍提示 no definition，#2 已重新打开继续跟进。
- `951c9ea fix(plan-09): invalidate stale struct macro cache`
  - 将 cache schema version 升到 5，拒绝上一轮 parser/collector 修复前写出的 version 4 cache。
  - 诊断结论：成员跳转失败符合旧 cache 仍把 `inputData` 存成 `v2f` struct member 的症状；重建索引后 handler 可将 `inputData.positionWS` 跳到 URP `Input.hlsl` 的 `InputData.positionWS`。
  - 验证：`npm run test -w @unity-shader-nav/server` PASS（46 files / 272 tests），`npm run build` PASS。
- `052d317 feat(issue-9): parse complex member receivers`
  - `memberAccessAt()` 现在能保留 `lights[i]`、`surface.brdfData` 这类 receiver expression，供 definition/reference 解析继续推导类型。
- `31fda71 feat(issue-9): infer array and nested member receivers`
  - `resolveMember()` 现在支持 array element receivers、nested struct fields，并保留 cbuffer/global struct receiver 覆盖。
- `811d719 feat(issue-9): infer receiver type from call assignment`
  - 新增 `FileIndex.typeInferences` assignment facts；cache schema version 升到 6，拒绝 pre-RHS-inference cache。
  - 仅支持同 scope 中 `receiver = MakeStruct()` 且可见函数候选 exactly one 的窄 RHS return type inference。
- `f4c94fd feat(issue-9): wire complex chain lookup handlers`
  - Definition handler 覆盖 #9 四类形状；Find References 侧记录并使用复杂 receiver expression，避免同名 member 混入其他 struct。
  - 暂不支持：跨行 receiver、宏展开 receiver、分支/三元表达式类型推断、overload-aware return type selection、非普通 Unity HLSL member access 的 pointer/reference-like 语法。
- `9a1cbe9 fix(issue-7): filter Unity macro sentinel references`
  - `CBUFFER_END`、`UNITY_INSTANCING_BUFFER_START/END` 等 Unity 结构性宏 sentinel 不再作为普通 references 进入索引，避免污染 Find References / definition candidates。
  - `BUILTIN_SENTINEL_MACROS` 纳入 `macroTableHash()`，旧 cache 会因 fingerprint mismatch 失效，无需 cache schema bump。
  - 验证：server vitest 48 files / 315 tests PASS，`npm run build` PASS。
  - 状态：GitHub issue #7 已按用户要求关闭；未做 Extension Development Host 手动验证，后续真实使用中若复现再 reopen。
- `78a749d..ef36766 issue-3 performance/cache hardening`
  - 新增 `npm run bench:issue3`，支持 synthetic `--files` 和真实项目 `--project` smoke，输出 cold scan / warm restore / persist / cache bytes。
  - `CacheStore` 不再先删除旧 `index.json`，改为同目录 tmp 写入后直接 rename，rename 失败时保留旧 manifest 并清理 tmp。
  - `walkFiles()`、cache restore、missing-file refresh、full scan、persist snapshot 改为 bounded concurrency；persist 前按 URI 排序，避免并发完成顺序导致 cache JSON 漂移。
  - Cache JSON 继续保持 monolithic：800 synthetic 文件基线约 2.45 MB，写入不是主瓶颈，暂不引入 shard/compression 复杂度。
  - benchmark：800 synthetic 文件最终 cold `296.94ms -> 157.80ms`，warm `99.96ms -> 68.41ms`，persist `25.31ms -> 11.92ms`。
  - 验证：`npm run test -w @unity-shader-nav/server` PASS（49 files / 324 tests），`npm run build` PASS。

## 历史实施索引

详细 plan 仍保留，但不建议在日常 debug 时通读：

- [plans/README.md](plans/README.md)：13 个 plan 索引与依赖图。
- [HANDOFF-2026-05-22.md](HANDOFF-2026-05-22.md)：规划转实施时的快照。
- [plans/REVIEW-2026-05-22.md](plans/REVIEW-2026-05-22.md)：初始 blocker/risk/polish 清单。
- [plans/2026-05-23-overall-consistency-fixes.md](plans/2026-05-23-overall-consistency-fixes.md)：P1/P2 release、workspace、cache、reference、Electron 稳定性修订。
- `plans/planXX*.md`：单个 plan 的实施、review、fix 细节。

13 个 plan 的当前结论：

| 范围 | 结论 |
|---|---|
| Plan 01-13 | MVP 主线已完成 |
| Overall Consistency Fixes | P1/P2 已完成并验证 |
| Deferred / follow-up | 已迁移到 GitHub Issues |

## 验证基线

常用命令：

- `npm run build`
- `npm run test -w @unity-shader-nav/server`
- `npm test`
- `node tests/out/runTest.js`

最近可信验证记录：

- 2026-05-24 Overall Consistency Fixes：clean 后 `npm test` PASS，Electron 21/21，server vitest 46 files / 256 tests。
- 2026-05-24 builtin package fix：server vitest 46 files / 262 tests PASS。

## 注意事项

- 仓库执行纪律仍然是“完成一个明确 task 就提交一个 commit”。
- 禁止创建 `codex/` 前缀分支。
- 不要使用 `--no-verify`、`--force-with-lease`、`git reset --hard` 等绕路操作。
- `docs/superpowers/TODO.md` 现在只是 issue 入口，不再保存完整 backlog。
