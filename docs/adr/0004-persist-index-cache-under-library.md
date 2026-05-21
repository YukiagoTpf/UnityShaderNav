# Persist Index Cache under `Library/`

## Context

经 ADR-0002 修正后，典型 URP 项目首次索引涉及 1000+ 文件，冷启动耗时 10-50 秒。如果每次启动都全量重建，对日常工作严重打断。需要把索引序列化到磁盘，下次启动时按 `(filepath, mtime, size)` 校验后增量加载。

缓存位置有几种合理选项：
- 项目内 `.vscode/`（可能误提交，污染 git diff）
- VSCode `globalStorageUri`（不污染项目，但 multi-project 时需要按 workspace 哈希区分）
- 项目的 `Library/`

## Decision

把缓存写到 `<projectRoot>/Library/UnityShaderNavCache/`。

## Why Library/

1. **天然 gitignore**：所有 Unity `.gitignore` 模板默认 ignore `Library/`，零额外配置就不会污染 git
2. **生命周期与 Unity 自身缓存对齐**：用户删 `Library/` 重建项目时，shader 索引缓存也自动失效——这是用户期待的行为
3. **项目本地存储**：multi-project / 多机器各自隔离，不会发生 workspace ID 冲突
4. **可发现性**：开发者排查问题时，"项目相关的扩展状态都在 Library/" 是符合直觉的

## Fallback

Standalone 模式（spec §5 Q5/C2，用户打开单个 `.hlsl` 文件、没有 Unity 项目结构）下没有 `Library/` 目录——此时降级到 VSCode `globalStorageUri`，按打开的文件路径哈希分桶。

## Consequences

- 缓存格式需要带版本号——扩展升级时不兼容的旧缓存直接丢弃重建。
- 用户运行 `Library/` 清理脚本时会触发全量 rebuild——预期行为，不报错。
