# Conservative Preprocessor Branch Dimming

## Context

Unity Shader 作者经常用 `#ifdef`/`#ifndef`/`#if defined(...)` 把代码切成
"当前编译变体下生效" 和 "不生效" 两类分支。Rider 等工具会把不生效的分支
**变暗显示**，帮助作者一眼看出哪些代码块当前是关闭的或被 variant keyword 门控的。

UnityShaderNav 本身**不评估**预处理条件（见 [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md)：
索引展平所有 `#ifdef` 分支，导航/Find References 一律忽略预处理状态）。issue #22
要的是一个**只影响呈现**的编辑器辅助：把不生效 / variant 门控的分支变暗，而不去
声称做到了编译器级别的 Unity variant 求值。

难点在于：真实的激活与否取决于 material/global keyword、平台 define、include 链里
被定义的宏，这些信息在单文件、无编译上下文的扫描里**无法确定**。一个过于激进的
实现会把实际可能生效的分支误判为关闭（false dimming），比单纯不变暗更糟糕。

## Decision

实现一个**纯呈现层**的保守分支变暗，**不是** variant 求值：

### 四值保守逻辑（UNKNOWN 优先于 VARIANT）

每个分支条件求值为四值之一：`TRUE` / `FALSE` / `VARIANT` / `UNKNOWN`。
`evalDefined(name)` 的优先级是：本地 `defined` → 本地 `undefed` → variant keyword →
否则 `UNKNOWN`。组合逻辑（`&&` / `||` / `!`）里，吸收性的确定值先判，**然后
`UNKNOWN` 优先于 `VARIANT`**：

- `VARIANT && UNKNOWN → UNKNOWN`、`VARIANT || UNKNOWN → UNKNOWN`（保持可见）。
- 只有当所有非-`VARIANT` 操作数都是非吸收性的确定值时才得到 `VARIANT`
  （`VARIANT && TRUE → VARIANT`、`VARIANT || FALSE → VARIANT`）。

含义：一个**可能**通过未知宏（来自 include / material keyword）而生效的分支，
绝不会被当作"仅 variant 门控"而变暗。这是对 false dimming 的刻意防御。

### Variant keyword 来自 pragma，`.shader` 全文件收集

variant keyword 取自 `#pragma multi_compile*` / `#pragma shader_feature*`
家族（前缀匹配，丢弃 Unity 的 `_` 占位符）。对 `.shader` 文件，这些 keyword
**跨所有 HLSL/CG 块全文件收集**，因为 `HLSLINCLUDE` 里声明的 `multi_compile`
对后续 program block 同样可见。

### 本地 `#undef` 是权威 FALSE

在同一预处理流里，本地 `#undef X`（且其后未被重新 `#define`）让 X 成为
**确定未定义**：后续 `#ifdef X` 判为 `FALSE`（变暗），`#ifndef X` 判为 `TRUE`
（保持可见）。只有**从未在本地出现过**、且不是 variant keyword 的名字才停留在
`UNKNOWN` → 保持可见（它可能在未扫描的 include 里被定义）。这就是对 false
dimming 的偏向：我们只变暗能被论证的分支（确定为 false，或被 variant 门控）。

### `.shader` 预处理单元模型

不孤立分析每个块：

- `HLSLINCLUDE`/`CGINCLUDE` 块的**顶层确定** `#define`/`#undef` 会**种子注入**
  后续 program block 的确定宏状态——对齐 [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md)
  记录的 "`HLSLINCLUDE` 块内符号对所有后续 Pass 可见"。
- program block 自己的 define **不跨 Pass 泄漏**：一个 `HLSLPROGRAM` 里的
  `#define` 不影响 sibling `HLSLPROGRAM`。
- **近似项（非精确建模）**：多 `SubShader` 的作用域，以及 include 块内部嵌套在
  条件分支里的 define，都按近似处理，不保证精确。

### 合并的 inactive/variant 呈现，但协议保留 reason

第一版把 "确定不生效" 和 "variant 门控" 合并成同一种变暗呈现。但 analyzer 内部
以及 LSP 协议（`InactiveRegion.reason: 'inactive' | 'variant'`）都**逐区间携带
reason**，因此未来 issue 想拆分两种呈现样式时，无需重新推导。

### Pull request + 客户端 decoration 投递

复用既有 semantic-tokens handler 的 pull 模式：客户端通过自定义 LSP 请求
`unityShaderNav/inactiveRegions` 拉取变暗区间，服务端在文档文本上跑 analyzer
返回结果，客户端用一个降低不透明度的 `TextEditorDecorationType` 渲染。因为自定义
`onRequest` 没有内置的文档版本 / 刷新处理，协议**显式携带 `textDocument.version`**，
服务端原样回传，客户端落 decoration 前校验版本并**只允许最后一次响应生效**
（stale-response guard）。

## Why not full variant evaluation / server push

1. **不做编译器级 variant 求值**：完整 Unity variant 枚举需要 keyword set 笛卡尔积、
   material/global keyword、平台 define、URP/HDRP define 等，远超本 issue 范围
   （与 [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md) 拒绝复刻
   Rider Shader Context Picker 的理由一致）。保守变暗只需可论证的局部信息。
2. **不做 semantic-token modifier 变暗**：只有 decoration 能在可配置不透明度下变暗
   整段区域（含注释、空行、嵌套指令）。semantic tokens 只能给单个 token 着色。
3. **第一版不做 server push**：semantic-tokens handler 已证明 pull 模式可行
   （解析索引、读文档文本、返回结果），复用 `RequestSuspender` 即可，避免把 push
   接进 `reindex` 管线。push 留待后续按需演进。

## Consequences

- 导航 / Find References / 补全 / 签名帮助**完全不受影响**——变暗只是呈现层；这些
  功能继续忽略预处理状态。
- 偏向不变暗：可能通过 include / material keyword 生效的分支保持可见，宁可漏暗
  也不误暗。代价是某些"实际关闭"的分支不会变暗（接受这个保守取舍）。
- `.shader` 的多 `SubShader` 作用域和 include 块内嵌套条件里的 define 是近似的，
  极端结构下可能与真实编译单元有偏差。
- 协议已携带 `reason`，未来拆分 inactive / variant 呈现样式无需改 analyzer，只需扩展
  客户端渲染。
- 自定义请求依赖显式 version 回传与客户端 stale-guard 来避免快速编辑时旧响应覆盖
  新 decoration。
