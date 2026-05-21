# Multi-candidate Peek for Ambiguous Symbols

## Context

Unity Shader 代码大量依赖预处理器分支（`#ifdef SHADER_API_*`、`multi_compile`、`shader_feature`），同一个符号（如 `TransformObjectToHClip`、`SAMPLE_TEXTURE2D`）在 URP/HDRP 里常常有多个平台 / 实例化变体的 `#define`。同样地，`.shader` 文件内多个 Pass 各有独立编译单元，可合法定义同名函数（vert/frag/entry）。

## Decision

不评估预处理条件，也不为 Pass 维护独立 scope。**索引所有 `#ifdef` 分支下的符号，所有 Pass 的 HLSL 块都展平到同一个文件级符号表**；当用户 F12 命中多个候选时，返回 LSP `Definition[]`，由 VSCode 的 Peek Definition UI 让用户挑选。

## Why this and not Rider's Shader Context Picker

Rider 通过分析当前文件激活的 `#pragma multi_compile` 集合，**唯一确定** F12 目标。这需要：
1. 完整的 multi_compile 语义模型（含 keyword set 笛卡尔积、`shader_feature_local` 等）
2. 用户在 UI 上切换"当前上下文"的交互（Rider 的 Shader Context Picker）
3. 工程量约为整个 MVP 的 50% 以上

MVP 目标是 Rider **基础**跳转的体验，不是完整复刻。多候选 Peek 是 VSCode 原生 UX，用户不需要学新概念，且在"两个分支都是有效目标"的常见场景（同名函数在 Forward/Shadow Pass 都有定义）下反而比 Rider 更直观。

Shader Context Picker 留作 P2 演进方向（spec §13.4），届时可在多候选基础上叠加"激活分支"作为默认选中项。

## Consequences

- `SymbolIndex` 类型必须是 `Map<string, SymbolEntry[]>`（数组而非单值），不去重。
- `.shader` 文件多 Pass 间的同名函数会作为多候选展示——文档需明确这是有意行为，不是 bug。
- `HLSLINCLUDE` 块内的符号自动对所有后续 Pass 可见（自然结果，无需特殊建模）。
