# Persist Index Cache under `Library/`

## Status

Accepted; Workspace identity partitioning and persistence ordering clarified on
2026-07-11 by [#62](https://github.com/YukiagoTpf/UnityShaderNav/issues/62).

## Context

典型 URP 项目首次索引涉及 1000+ 文件，冷启动耗时可达数十秒。每次启动都全量重建会持续打断日常工作，因此索引需要序列化到磁盘，并在下次启动时按稳定的 source identity 校验后恢复。

缓存位置有几种合理选项：

- 项目内 `.vscode/`：可能误提交并污染 git diff。
- VS Code `globalStorageUri`：不污染项目，但 Unity 项目的缓存生命周期不可见。
- Unity 项目的 `Library/`：默认被忽略，并与 Unity 派生数据共同清理。

仅选择 `Library/UnityShaderNavCache/index.json` 仍不足够。父 Workspace 与嵌套 Workspace 可以解析到同一个 Unity project root，但它们具有不同的索引边界和 `workspaceFolderUri`。如果共享一个 manifest，后写入者会让另一 identity 在下次启动时拒绝缓存。

缓存保存还需要明确排序边界。同一进程中的多个 `CacheManager` 可以指向同一最终路径；把所有 save 串行排队会浪费 I/O，而仅比较 Workspace revision 也不成立，因为 revision 只在单个 Workspace session 内有序，跨实例或跨进程不可比较。

## Decision

### Location and identity

Unity 模式下，每个 canonical Workspace identity 使用以下路径：

```text
<UnityRoot>/Library/UnityShaderNavCache/workspaces/<identity-hash>/index.json
```

`identity-hash` 的输入是 canonical Workspace folder URI，并复用 Workspace ownership 的 file-URI 规范化规则。等价 Windows drive-letter URI 选择同一分桶；父子 Workspace 即使解析到同一个 Unity root，也选择不同分桶。Manifest 身份验证对 Workspace URI 使用同一规则，对 Unity root 使用平台 filesystem path identity；因此 Windows 路径大小写不会把同一 identity 误判为 cache miss。

Standalone 模式没有 Unity `Library/`，继续使用 VS Code `globalStorageUri` 下的 per-workspace 分桶。没有 Unity root 且没有 global storage 时禁用持久化缓存。

### Format and eligibility

每个 identity 保持一个 monolithic JSON manifest。暂不把文件记录拆成独立对象；现有 benchmark 没有证明 manifest 大小或单次原子替换是主要瓶颈。

manifest 只包含已发布 revision 的 disk projection 及与每个 `FileIndex` 同一次稳定读取捕获的 source identity。Live overlay、`DocumentAnalysis`、document attempt、lifecycle state 和 source warning 不持久化。缓存格式版本只描述 schema；Index implementation identity 覆盖 server/parser runtime、grammar 和影响索引的配置。

Package 成员资格仍由当前 `Packages/packages-lock.json` 决定。缓存记录不能让已从 lockfile dependency graph 移除的 Package 重新进入索引：Unity root 外的缓存文件只有仍属于当前 resolved package root 时才可恢复；root 内的普通项目文件继续按用户文件边界处理。

### Persistence ordering

`CacheManager` 是持久化 owner。需要保存一个已发布 revision 时，Workspace 立即提交该 immutable revision 的 disk projection；以 canonical filesystem identity 表示的最终 manifest path 为键，协调必须在任何异步 snapshot 或 manifest preparation 之前建立。

一个 language-server process 内，同一路径最多保留：

1. 一个 active request；以及
2. 一个 latest pending request。

新 pending request 替换旧 pending payload，并继承被合并请求的 waiters。Active 完成后只执行保留的最新 pending payload，因此中间状态可以 coalesce，而进程内最后入队的请求不会丢失。指向同一路径的不同 `CacheManager` / `CacheStore` 实例共享这一协调边界。

`CacheStore` 继续在目标目录创建临时文件，并以 atomic rename 替换 manifest。Active failure 只拒绝该 request，随后仍然 drain latest pending request；replacement failure 保留此前完整有效的 manifest。Workspace 把保存视为 best-effort derived state，失败不回滚已发布的内存 revision，也不改变 lifecycle。

latest-request-wins 只在单个进程内成立，因为这里存在可观察的 enqueue order。两个 server process 没有共享 revision domain 或 total order；atomic rename 只保证最终文件完整有效，不承诺哪个进程的请求在语义上更新。跨进程 epoch、lock 或 compare-and-swap 协议属于独立决策。

## Why `Library/`

1. **天然 gitignore**：Unity `.gitignore` 模板默认忽略 `Library/`，不会污染源码状态。
2. **生命周期一致**：用户删除 `Library/` 重建项目时，shader 索引缓存一并失效。
3. **项目本地且 identity 隔离**：不同 Unity roots 天然隔离；同一 root 内再按 canonical Workspace identity 隔离。
4. **可发现性**：排障时可以从 Unity 的派生数据目录定位缓存。

## Consequences

- 清理 `Library/` 会触发全量 rebuild，这是预期行为。
- canonical identity 算法是持久化路径协议；变更它会产生新分桶，而不是迁移或猜测旧路径。
- 每个 identity 仍执行 monolithic atomic replacement；只有测量证明它成为瓶颈时才重新评估格式。
- 同进程可以合并冗余 save，同时保证最新 pending request 最终运行。
- 跨进程只保证 manifest 完整性，不保证 latest-request-wins。
- 缓存始终是可丢弃的派生状态；失败不能削弱已发布 revision 或 manifest-driven Package membership。
