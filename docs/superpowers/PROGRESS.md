# UnityShaderNav 进度快照

更新于：2026-05-24。第一次接手本仓库时先读 [CLAUDE.md](../../CLAUDE.md)，再读本文。

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
| [#2](https://github.com/YukiagoTpf/UnityShaderNav/issues/2) | struct 类型和成员跳转：`Customdata customdata;`、`i.positionWS` 等 | Closed |
| [#3](https://github.com/YukiagoTpf/UnityShaderNav/issues/3) | 大项目索引性能、cache 体积、跨进程 cache 写入硬化 | Open |
| [#4](https://github.com/YukiagoTpf/UnityShaderNav/issues/4) | CI 缓存 `.vscode-test/` 下载 | Open |
| [#5](https://github.com/YukiagoTpf/UnityShaderNav/issues/5) | `clean` 清理 `tests/out`，避免 stale Electron tests | Open |
| [#6](https://github.com/YukiagoTpf/UnityShaderNav/issues/6) | F5 开发用 runtime watch/dev script | Open |
| [#7](https://github.com/YukiagoTpf/UnityShaderNav/issues/7) | 过滤 Unity macro sentinel references | Open |
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
