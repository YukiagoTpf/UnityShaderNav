# Macro-pattern Whitelist Instead of Macro Expansion

## Context

Unity Shader 中大量符号是**通过宏调用声明的**，而不是 HLSL 语法的直接声明：

```hlsl
TEXTURE2D(_MainTex);                          // _MainTex 通过宏声明
SAMPLER(sampler_MainTex);
UNITY_DECLARE_INSTANCED_PROP(float4, _Color)
```

`tree-sitter-hlsl` 解析时把这些识别为 `call_expression`，参数 `_MainTex` 只是 identifier reference，**不会进入符号表**。同时，`#pragma vertex vert` / `#pragma kernel CSMain` 等指令也需要把后续 token 当作函数 reference 处理，否则 F12 直接失败。

要把这些"伪声明 / 伪引用"接入索引，理论上有两条路：完整的 C-preprocessor 展开（含 token paste `##`、嵌套展开），或是基于模式的白名单识别。

## Decision

不实现宏展开。**维护一组 declaration patterns 和 reference patterns 白名单**，在符号收集阶段对匹配的 `call_expression` 节点做特殊处理：

- **declaration patterns**：`TEXTURE2D($name)`、`SAMPLER($name)`、`UNITY_DECLARE_TEX2D($name)`、`CBUFFER_START($name)`、`UNITY_DEFINE_INSTANCED_PROP(_, $name)`、CG 时代的 `sampler2D $name`、`fixed4 $name` 等 → 把 `$name` 登记为变量 / cbuffer
- **reference patterns**：`#pragma vertex $func`、`#pragma fragment $func`、`#pragma geometry/hull/domain/kernel $func` → 把 `$func` 登记为函数引用

白名单内置一组 Unity 官方稳定的模式，**允许用户通过 `unityShaderNav.declarationMacros` 配置追加**——覆盖魔改 Unity / 用户自定义 declaration 宏的场景。

## Why not full macro expansion

1. **工程量**：完整宏展开需要实现 token-level preprocessor（包括嵌套展开、token paste、stringification、conditional），是 MVP 范围之外的复杂度。
2. **稳定性**：Unity 官方 declaration 宏的命名模式非常稳定（多年没变），白名单维护成本远低于通用展开器。
3. **可观察性**：白名单失配时容易诊断（"这个宏不在表里"），通用展开器出错时排查痛苦。

## Consequences

- 用户自定义 declaration 宏不在默认白名单中时，F12 在通过该宏声明的变量上会失败——通过配置项 `declarationMacros` 兜底。
- CG 兼容（spec §6）复用同一机制：`sampler2D`、`UNITY_INSTANCING_BUFFER_START` 等 CG 特有声明语法都进白名单。
- 宏体内的内容不展开——F12 跳到宏定义本身（`#define X ...`），不进入宏体内的符号。这是有意限制。
