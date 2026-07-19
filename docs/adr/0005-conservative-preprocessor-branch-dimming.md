# Conservative Preprocessor Branch Dimming

## Context

Unity Shader 作者经常用 `#ifdef`/`#ifndef`/`#if defined(...)` 把代码切成
"当前编译变体下生效" 和 "不生效" 两类分支。Rider 等工具会把不生效的分支
**变暗显示**，帮助作者一眼看出哪些代码块当前是关闭的或被 variant keyword 门控的。

UnityShaderNav 本身**不评估**预处理条件（见 [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md)：
索引展平所有 `#ifdef` 分支，导航/Find References 一律忽略预处理状态）。这里需要的是
一个**只影响呈现**的编辑器辅助：把不生效 / variant 门控的分支变暗，而不去
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

### 支持的条件表达式子集

呈现层求值器支持十进制整数、裸宏名、`defined`、`!`、整数比较、括号以及按 C
优先级组合的 `&&` / `||`。整数 `0` 为假，其他整数为真；裸宏名复用与 `#ifdef`
相同的四值状态。只有两侧都拥有可证明的整数值时才执行比较，因此未知宏或仅能证明
“已定义”但不知道替换值的宏参与比较时仍返回 `UNKNOWN`。算术、位运算、宏调用及其他
未支持语法整体返回 `UNKNOWN`，不会依靠局部猜测变暗分支。

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

### inactive/variant 使用不同呈现

analyzer 与 LSP 协议（`InactiveRegion.reason: 'inactive' | 'variant'`）都**逐区间携带
reason**，客户端直接按 reason 投递两种 decoration："确定不生效" 只使用可配置的
不透明度；"variant 门控" 使用相同不透明度，并叠加
`editor.wordHighlightBackground` 主题色背景。主题色随明暗主题变化，且 decoration
不设置文字前景色，因此不会覆盖 semantic token 的着色。

### Pull request + 客户端 decoration 投递

复用既有 semantic-tokens handler 的 pull 模式：客户端通过自定义 LSP 请求
`unityShaderNav/inactiveRegions` 拉取变暗区间，服务端在文档文本上跑 analyzer
返回结果，客户端为每个 URI 懒创建一对 `TextEditorDecorationType`。同一 URI 的
decoration、debounce timer 和请求身份归入一个文档状态；文档关闭或有效配置变化时，
该状态会整体释放，timer 会取消，两种 decoration 都会 dispose。因为自定义
`onRequest` 没有内置的文档版本 / 刷新处理，协议**显式携带 `textDocument.version`**，
服务端原样回传；客户端同时校验 version 和唯一请求身份，只允许当前文档会话的最后
一次响应生效，因此同 URI、同 version 的关闭后重开也不会接收旧响应。

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
- 协议携带的 `reason` 直接驱动 inactive / variant 两种客户端呈现；analyzer 无需承担
  编辑器主题语义。
- 自定义请求依赖显式 version 回传、请求身份和文档关闭时的状态释放，避免快速编辑或
  关闭后重开时旧响应覆盖新 decoration。

## Status Update (2026-07)

The original decision (presentation-only dimming, four-valued logic, UNKNOWN
dominates VARIANT) still holds as the **default and fallback** when no
`VariantContext` is supplied. Slices 1–5 of the variant-context epic
(#154–#158) extend the dimming behaviour without changing the four-valued
guard:

- When a `VariantContext` is supplied, `evalCondition` resolves variant
  keywords to TRUE/FALSE instead of VARIANT. A branch gated by an active
  keyword evaluates TRUE (not dimmed); a branch gated by an inactive keyword
  evaluates FALSE (dimmed as `reason: 'inactive'`, not `'variant'`).
- Branches that still evaluate VARIANT (keyword not declared in the context's
  document, or genuinely unknown macros) keep the existing `reason: 'variant'`
  presentation — the conservative false-dim guard is unchanged.
- The `ChainState` bookkeeping and `applyClauseRule` / `applyElseRule` logic
  are untouched; they already handle TRUE/FALSE/VARIANT correctly. Only the
  input to `evalCondition` changed (an optional `variantContext` on
  `MacroState`).
- Navigation (definition / references / highlights) now also uses the context
  to prefer the active candidate — see [ADR-0001](0001-multi-candidate-peek-for-ambiguous-symbols.md)
  Status Update. Dimming remains presentation-only; the context simply makes
  the presentation sharper when the user opts in.

No claim of compiler-accurate variant resolution is made: the context is
user-driven and covers only the keywords the document itself declares via
`#pragma multi_compile*` / `shader_feature*`.
