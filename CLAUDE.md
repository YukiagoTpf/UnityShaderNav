# Agent 协作约定 — UnityShaderNav

这个仓库是 VS Code 扩展 + LSP 服务，给 Unity Shader 文件做代码导航（F12 / Find References / Outline / Highlight）。旧的实施计划已归档到 git history；当前协作以公开文档、GitHub Issues 和代码测试为准。

## 执行纪律

- **执行完一个明确 Task 就提交一个 commit。** 不要把多个无关 Task 合并到一个 commit，不要 amend 已 push 的提交。
- **禁止创建 `codex/` 前缀分支。**
- **不要 `--no-verify` / `--force-with-lease` / `git reset --hard`** 等绕路操作。失败先诊断，修了再开新 commit。
- 提交信息沿用 conventional commits，例如 `feat(issue-10): ...`、`fix(issue-7): ...`、`test(issue-8): ...`、`docs: ...`。
- 遇到 GitHub issue 与现实有偏差时，优先把新的诊断、取舍和验证结果写回对应 issue，不再新建本地 fixplan 文档。

## 当前信息入口

- `README.md` — 项目公开入口。
- `CHANGELOG.md` — 对外变更记录。
- `docs/README.md` — 文档索引。
- `docs/development.md` — 本地开发、调试和测试命令。
- `docs/architecture.md` / `docs/adr/` — 架构说明和长期决策。
- `docs/roadmap.md` — 当前方向摘要；实际 backlog 以 GitHub Issues 为准。
- GitHub Issues — bug、feature、fix plan、实现总结和验证记录的主入口。

## 当前发布状态

- 最新发布版本：`v0.0.7`。
- Release 地址：https://github.com/YukiagoTpf/UnityShaderNav/releases/tag/v0.0.7
- 最新 VSIX 产物：`unity-shader-nav/client/unity-shader-nav-0.0.7.vsix`。
- `client/package.json` 当前插件版本为 `0.0.7`，并使用 `client/images/icon.png` 作为 VS Code Marketplace 图标。
- 0.0.7 亮点：Workspace symbol search（Ctrl+T，#19）；`?path=` git package 解析 + git 包目录 hash 截 10 字符（#25）。

## 已知坑

- **路径渲染幻觉**：harness 在显示 tool 输出（Read / Grep / Bash stdout）时，可能把路径里的字面内容渲染得不可信。判断是真污染还是显示幻觉，用 `od -c` 或 `cat | hexdump` 看 raw bytes。

## 项目入口

- 源码 root：`unity-shader-nav/`
- 顶层命令在 `unity-shader-nav/` 下跑：`npm run build` / `npm test` / `npm run watch`
- 调试：在 VS Code 里打开 `unity-shader-nav/` 文件夹按 F5
