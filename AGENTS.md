# Agent 协作约定 — UnityShaderNav

这个仓库是 VSCode 扩展 + LSP 服务，给 Unity Shader 文件做代码导航（F12 / Find References / Outline）。规划完成、按 13 个 plan 实施中。

## 执行纪律

- **执行完一个 Task 就提交一个 commit。** 不要把多个 Task 合并到一个 commit，不要 amend 已 push 的提交。commit message 要描述实际修改内容，不要写 Task/Step 编号或步骤信息。
- **遇到 Plan 与现实有偏差**：先用 `Edit` 在 plan 文档里加 `> Note:` 说明偏离原因，再继续；不要静默偏离。
- **不要 `--no-verify` / `--force-with-lease` / `git reset --hard`** 等绕路操作。失败先诊断，修了再开新 commit。
- 提交信息沿用 conventional commits：`feat(plan-XX):` / `fix(plan-XX):` / `test(plan-XX):` / `chore(plan-XX):` / `docs(plans):` 等。

## 进度跟踪

- **`docs/superpowers/PROGRESS.md`** — 13 个 plan 的当前状态、follow-up TODO、待手动验证项。开会话第一件事读这个。
- `docs/superpowers/HANDOFF-2026-05-22.md` — 项目阶段总览（规划→实施切换点的快照）。
- `docs/superpowers/plans/README.md` — plan 索引 + 依赖图。
- `docs/superpowers/plans/REVIEW-2026-05-22.md` — 10 Blocker / 9 Risk / 7 Polish 的合并清单，Blocker 已全部修订（commit `04e5140..406a4f5`）。

## 已知坑

- **路径渲染幻觉**：harness 在显示 tool 输出（Read / Grep / Bash stdout）时，会把字面 `Project` 替换成 `Project` 给你看，实际文件内容仍是 `Project`。判断是真污染还是显示幻觉，用 `od -c` 或 `cat | hexdump` 看 raw bytes。仓库现已无实际污染。

## 项目入口

- 源码 root：`unity-shader-nav/`（Plan 01 创建）
- 顶层命令在 `unity-shader-nav/` 下跑：`npm run build` / `npm test` / `npm run watch`
- 调试：在 VSCode 里打开 `unity-shader-nav/` 文件夹按 F5
