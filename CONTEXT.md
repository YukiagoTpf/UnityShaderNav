# UnityShaderNav

VSCode 扩展，为 Unity Shader 文件（ShaderLab + HLSL）提供代码导航。本文件定义项目术语，避免讨论时各说各话。

## Language

### 文件与项目

**Unity project root**:
同时包含 `Assets/` 和 `ProjectSettings/` 的目录。是 #include 路径解析（Packages/、Library/PackageCache/）的基准点。
_Avoid_: workspace folder, project directory

**Workspace folder**:
VSCode 的 `${workspaceFolder}`——用户在 VSCode 里打开的根目录。**不等于** Unity project root（Unity 项目可能位于 workspace 的子目录）。

**Standalone mode**:
扩展激活但未检测到 Unity project root（无 `Assets/ + ProjectSettings/`）时的降级运行状态。同文件内符号导航仍可用，跨文件跳转和 #include 解析禁用。
_Avoid_: degraded mode, no-project mode

**Include chain**:
从某文件出发递归跟随 `#include` 形成的传递闭包文件集合。用于跨文件跳转和 Find References 的范围判定。

### 符号收集

**Declaration macro**:
通过宏调用声明变量 / cbuffer / sampler 的模式（如 `TEXTURE2D(_MainTex)`、`SAMPLER(...)`、`CBUFFER_START(...)`）。索引器内置一份白名单识别这些"伪声明"，详见 ADR-0003。
_Avoid_: declarative macro, macro declaration

**Reference macro pattern** / **Reference pattern**:
形如 `#pragma vertex $func` / `#pragma kernel $func` 等需要把后续 token 当作函数引用处理的模式。与 declaration macro 共用同一张白名单表，但语义类型不同。

**Symbol entry**:
索引中的一条记录。键为符号名，值为 `SymbolEntry[]`（多个候选共存——见 ADR-0001）。
_Avoid_: symbol record, symbol info

**Scope range**:
`SymbolEntry` 的字段，描述该符号在哪段文本范围内可见。全局符号 = 整个文件；函数参数 / 局部变量 = 所属函数体范围。用于 shadowing 判定和 Find References 的位置过滤。

**Proximity tie-break**:
同函数内多个同名局部变量声明（如不同 block scope 里重复用 `temp`）的 F12 消歧策略——按"最近的、行号 ≤ 引用行号的声明"返回。详见 spec §5。

### 索引生命周期

**Cold start**:
扩展激活后到全量索引完成的时间窗口。期间 LSP 请求挂起最多 5s + 进度条提示，详见 spec §8。

**Rebuild mode**:
文件变更超过阈值（20 个 / 500ms）或检测到分支切换 / packages-lock 变化时，索引进入的清空-重扫状态。区别于"增量更新"路径。

**PackageResolver**:
启动时读 `Packages/packages-lock.json`，构建 `package_name → physical_path` 映射的服务。是 ADR-0002 manifest-driven 策略的实现承担者。

### 跳转行为

**Multi-candidate Peek**:
同名符号有多个定义（#ifdef 分支、多 Pass 同名、HLSL overload）时，F12 返回所有候选，由 VSCode 原生 Peek UI 让用户挑选。是本扩展与 Rider Shader Context Picker 的关键差异——详见 ADR-0001。

**Chain lookup**:
struct 成员 F12（如 `surface.positionWS`）的解析过程——先推导 `surface` 的声明类型，再在该 struct 内查字段。MVP 阶段支持到 L3（含函数返回值），详见 spec §5。

### 补全与签名

**Cursor context**:
由 `analyzeCursor()`（`server/src/parser/lexical/cursor.ts`）统一产出的"光标处词法信息"结构：当前 word、member access（导航用）、词法态（code/comment/string）、补全分类（HLSL/ShaderLab/semantic/state-value）、补全前缀与 member 补全上下文。F12/hover/highlight 等导航与补全/签名共用这一份分析，取代了过去散落在 `wordAt`/`suggestionContextAt`/`isGenericDefinitionContext` 三处的重复实现。
_Avoid_: lexical state, parser context

**Suggestion context**:
补全/签名帮助请求位置的粗粒度上下文分类，例如 HLSL code、ShaderLab code、semantic position、ShaderLab state value、comment、string。用于避免把 ShaderLab 状态词塞进普通 HLSL 表达式，或在注释/字符串里返回建议。现在它是 **Cursor context** 面向补全的投影——即由 `classifyCursor` 产出的 `kind`/`prefix`/`member` 子集。
_Avoid_: completion mode, parser state

**Project-index suggestion**:
从当前文件索引、include-visible 文件索引、作用域信息和 chain lookup 推导出的补全项。它复用导航的可见性规则，优先级高于内置词汇。
_Avoid_: autocomplete symbol, completion cache

**Built-in vocabulary**:
维护在代码中的精选 Unity/HLSL/ShaderLab 词表，用于补全和部分内置函数签名帮助。它不是编译器完整标准库，也不应该假装覆盖所有 pipeline/package 版本。
_Avoid_: standard library, compiler symbols

**Signature help**:
LSP 的函数调用参数提示。UnityShaderNav 只在能保守识别单行 free-function call 和候选函数元数据时返回，遇到 overload-like 或预处理歧义时可以返回多个候选。
_Avoid_: hover, function docs

## Flagged ambiguities

**"Package"**:
- ✅ Unity Package（`com.unity.render-pipelines.universal` 这种）—— 本项目使用
- ❌ npm package（扩展本身的 npm 依赖）—— 讨论扩展实现时偶尔涉及，需上下文区分

**"Reference"**:
- ✅ "符号引用"（identifier 出现在使用点）—— Find References 的 R
- ❌ "引用类型"（与值类型相对）—— HLSL 无此概念，但 C++/C# 背景的人容易混淆

## 示例对话

> **TA**："F12 在 `TransformObjectToHClip` 上跳到了 4 个地方，怎么回事？"
> **开发者**："那是 multi-candidate Peek——这个函数在 URP 里有多个 #ifdef 分支版本（含 instancing / 不含），我们不评估预处理条件，所以全部当候选返回。挑你当前用的那个就行。"
> **TA**："Rider 就跳一个啊。"
> **开发者**："Rider 有 Shader Context Picker 推断激活分支，那是 P2 范围。MVP 走多候选，参见 ADR-0001。"
>
> **TA**："我 F12 在 `_MainTex` 上跳不到声明。"
> **开发者**："看一下声明长什么样——如果是 `TEXTURE2D(_MainTex)`，这是 declaration macro，需要白名单识别。它是不是项目自定义的宏？"
> **TA**："对，我们包了一层 `MY_TEX2D(...)`。"
> **开发者**："在 `unityShaderNav.declarationMacros` 里加上你的模式就行。"
