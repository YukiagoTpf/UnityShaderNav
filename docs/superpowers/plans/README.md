# UnityShaderNav 实施计划集

本目录把 `UnityShaderNav_Spec.md` 拆分为 13 个连续的实施计划。每个计划是一个**自给自足、可独立验证、可独立提交**的里程碑：完成后软件能跑、能测、能演示一种端到端能力。计划间通过明确的依赖关系串接，不允许"半成品"。

## 阅读顺序

按编号顺序执行；编号也是依赖顺序。下游依赖标在每个计划文件的"Dependencies"段。

| # | 计划文件 | 里程碑（完成即过） | 对应 Spec §10 验收 |
|---|---|---|---|
| 01 | [2026-05-22-01-project-scaffolding.md](2026-05-22-01-project-scaffolding.md) | TS monorepo 起步、扩展激活、LSP 握手通过 | — |
| 02 | [2026-05-22-02-shaderlab-block-parser.md](2026-05-22-02-shaderlab-block-parser.md) | 给定 `.shader` 文本，能返回 HLSL 块的精确行范围 | — |
| 03 | [2026-05-22-03-hlsl-symbol-collector.md](2026-05-22-03-hlsl-symbol-collector.md) | 给定 HLSL 源文本，能返回完整 `FileIndex`（符号 + 引用） | — |
| 04 | [2026-05-22-04-single-file-definition.md](2026-05-22-04-single-file-definition.md) | F12 在单文件内可用（函数、参数、局部变量） | Case 1, 8 |
| 05 | [2026-05-22-05-macro-pattern-recognizer.md](2026-05-22-05-macro-pattern-recognizer.md) | declaration/reference 宏白名单可识别 `TEXTURE2D`、`#pragma vertex` | Case 5, 6, 7 |
| 06 | [2026-05-22-06-include-resolver.md](2026-05-22-06-include-resolver.md) | F12 在 `#include "x.hlsl"` 上打开目标文件 | Case 4 |
| 07 | [2026-05-22-07-package-resolver-and-cross-file.md](2026-05-22-07-package-resolver-and-cross-file.md) | F12 跨文件跳进 Packages 中的定义；多 root 隔离 | Case 2, 3, 9 |
| 08 | [2026-05-22-08-index-lifecycle.md](2026-05-22-08-index-lifecycle.md) | 文件变更触发增量/重建；进度条 + 5s 挂起 | — |
| 09 | [2026-05-22-09-cache-persistence.md](2026-05-22-09-cache-persistence.md) | 索引序列化到 `Library/UnityShaderNavCache/`；冷启动 < 4s | — |
| 10 | [2026-05-22-10-document-symbols.md](2026-05-22-10-document-symbols.md) | Ctrl+Shift+O 显示大纲 | Case 12 |
| 11 | [2026-05-22-11-chain-lookup.md](2026-05-22-11-chain-lookup.md) | struct 成员 F12（L1-L3） | Case 10 |
| 12 | [2026-05-22-12-macro-definitions.md](2026-05-22-12-macro-definitions.md) | F12 在宏使用上跳到 `#define` | Case 11 |
| 13 | [2026-05-22-13-find-references.md](2026-05-22-13-find-references.md) | Shift+F12 列出引用；Packages 开关 | Case 13, 14 |

## 依赖图

```
01 scaffolding
  └─ 02 shaderlab block parser
       └─ 03 hlsl symbol collector
            └─ 04 single-file definition
                 ├─ 05 macro pattern recognizer
                 ├─ 06 include resolver
                 │    └─ 07 package resolver + cross-file
                 │         ├─ 08 index lifecycle
                 │         │    └─ 09 cache persistence
                 │         ├─ 10 document symbols
                 │         ├─ 11 chain lookup
                 │         ├─ 12 macro definitions
                 │         └─ 13 find references
                 └─ (P1 plans 10-13 only require 04 and any cross-file path)
```

MVP（spec §10 Case 1-9）= 计划 01 → 07 全部完成。
MVP+ / P1（Case 10-14）= 计划 08-13。

## 通用约定

- **代码组织**：monorepo `client/`（VSCode 扩展端）+ `server/`（LSP 进程），各自 `package.json` + `tsconfig.json`。共享类型放 `shared/`。
- **测试栈**：`vitest`（unit）+ `@vscode/test-electron`（integration）。所有 LSP 内核逻辑（parser、collector、resolver）必须可在 Node 环境单测，不依赖 VSCode API。
- **TDD**：每个任务先写失败测试 → 跑挂 → 写最小实现 → 跑过 → commit。
- **提交粒度**：每个 Task 结束 commit 一次；commit message 用 conventional commits（`feat:` / `fix:` / `test:` / `chore:`）。
- **fixture 文件**：放 `tests/fixtures/<plan-id>/`；真实 URP/HDRP 文件片段以最小可复现为准，不导入整个 Unity 项目。
- **类型一致性**：`SymbolEntry` / `FunctionSymbolEntry` / `ReferenceEntry` 的字段名以计划 03 的定义为准；后续计划只能新增字段，不允许重命名。

## 验证里程碑的方式

每个计划的 "Acceptance" 段对应 spec §10 的某些用例（或对应"基础设施可观察"的等价验证）。完成计划后必须：

1. 计划内所有 Task 的 checkbox 全部勾上
2. `npm test` 全部通过
3. 计划末尾的 "Manual Verification" 段在真实 VSCode 实例里走通
4. 完成提交，commit message 引用计划编号

只有当上述四点全部满足，该计划才算"完成"。

## 用法

每个计划文件顶部的 header 提示用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 执行。推荐 subagent-driven：单 task 一个 fresh subagent，两段式审核。
