# Agent 协作约定 — UnityShaderNav

这个仓库是 VS Code 扩展 + LSP 服务，给 Unity Shader 文件做代码导航（F12 / Find References / Outline / Highlight）。当前协作以公开文档、GitHub Issues 和代码测试为准。

## 执行纪律

- **执行完一个明确 Task 就提交一个 commit。** 不要把多个无关 Task 合并到一个 commit，不要 amend 已 push 的提交。
- **禁止创建 `codex/` 前缀分支。**
- **不要 `--no-verify` / `--force-with-lease` / `git reset --hard`** 等绕路操作。失败先诊断，修了再开新 commit。
- 提交信息沿用 conventional commits，例如 `feat(issue-10): ...`、`fix(issue-7): ...`、`test(issue-8): ...`、`docs: ...`。
- 遇到 GitHub issue 与现实有偏差时，优先把新的诊断、取舍和验证结果写回对应 issue，不新建本地 fixplan 或 handoff 文档。

## 权威入口

- `README.md` — 项目公开入口。
- `CONTEXT.md` — 稳定的领域术语与命名约定。
- `client/package.json` — 扩展身份、版本和 VS Code manifest。
- `CHANGELOG.md` — 对外变更记录。
- `docs/README.md` — 文档索引。
- `docs/development.md` — 本地开发、调试和测试命令。
- `docs/architecture.md` / `docs/adr/` — 架构说明和长期决策。
- GitHub Issues — backlog、诊断、实现总结和验证记录。

## 公共仓库边界

- 公开文档和源码注释只记录仓库事实或可公开验证的来源，不保留私有来源名称、链接、归因、个人绝对路径或历史执行记录。
- 已完成工作的过程材料留在 Git history 和对应 GitHub issue；当前树只保留长期有效的 Interface、决策和说明。

## 项目入口

- Git 仓库根目录同时是源码、npm workspace、文档和 Agent 上下文的唯一项目根目录。
- 顶层命令在仓库根目录运行：`npm run build` / `npm test` / `npm run watch`。
- 调试：在 VS Code 里打开仓库根目录后按 F5。

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `YukiagoTpf/UnityShaderNav`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage labels mapped in `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with `CONTEXT.md` and `docs/adr/` at the repository root. See `docs/agents/domain.md`.
