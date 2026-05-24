# UnityShaderNav TODO

更新于：2026-05-24。

本文件不再保存完整 backlog。项目已经进入真实项目 debug 阶段，后续可执行工作以 GitHub Issues 为准。

## 当前工作入口

- 进度快照：[PROGRESS.md](PROGRESS.md)
- GitHub Issues：https://github.com/YukiagoTpf/UnityShaderNav/issues
- 历史 plan：[plans/README.md](plans/README.md)

## 当前 open issues

| Issue | 主题 |
|---|---|
| [#1](https://github.com/YukiagoTpf/UnityShaderNav/issues/1) | F12 / References 应按 scope、include chain、canonical target 过滤 |
| [#2](https://github.com/YukiagoTpf/UnityShaderNav/issues/2) | struct 类型和成员跳转 |
| [#3](https://github.com/YukiagoTpf/UnityShaderNav/issues/3) | 大项目索引性能、cache 体积、跨进程 cache 写入 |
| [#4](https://github.com/YukiagoTpf/UnityShaderNav/issues/4) | CI 缓存 `.vscode-test/` |
| [#5](https://github.com/YukiagoTpf/UnityShaderNav/issues/5) | 清理 compiled Electron test output |
| [#6](https://github.com/YukiagoTpf/UnityShaderNav/issues/6) | F5 runtime watch/dev script |
| [#7](https://github.com/YukiagoTpf/UnityShaderNav/issues/7) | Unity macro sentinel reference 过滤 |
| [#8](https://github.com/YukiagoTpf/UnityShaderNav/issues/8) | CG legacy variable declaration indexing |
| [#9](https://github.com/YukiagoTpf/UnityShaderNav/issues/9) | Chain lookup L3b/L4 |
| [#10](https://github.com/YukiagoTpf/UnityShaderNav/issues/10) | 额外 Unity PackageManager path forms |

## 已归档的旧 TODO

以下内容曾经在本文件中，但已经完成、过期或迁移：

- VSIX runtime closure、package-layout guard、README staging、direct VSCE packaging：已由 Overall Consistency Fixes 完成。
- Workspace path normalization、lazy readiness、folder add/remove suspension、open document rebuild guard、cache manifest schema guard：已完成。
- Find References canonical target、include path references、generic F12 lexical gate、block-comment-aware pragma scan：已完成。
- Electron workspace/profile 隔离、resource-scoped settings manifest、多 root override coverage、Windows timing flakes 稳定化：已完成。
- P2/P3 follow-up：已转为 GitHub Issues #3-#10。

## 新问题记录规则

真实项目 debug 中发现的问题优先开 GitHub issue：

1. 标明复现代码形态和实际行为。
2. 写出期望行为。
3. 写最小 acceptance criteria。
4. 只有临时草稿才先放本文，确认后迁移到 issue。
