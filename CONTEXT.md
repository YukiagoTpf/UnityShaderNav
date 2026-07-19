# UnityShaderNav

VS Code 扩展，为 Unity Shader 文件（ShaderLab + HLSL）提供代码导航。本文件只管理稳定、用户可感知或领域层的术语与推荐命名；当前 class、module、source path 和内部拓扑仅在[架构文档](docs/architecture.md)中描述，不属于规范词表。可变状态与工作项见 GitHub Issues。

## Language

### 文件与项目

**Unity project root**:
同时包含 `Assets/` 和 `ProjectSettings/` 的目录。是 `#include` 解析 `Packages/` 与 `Library/PackageCache/` 路径的基准点。
_Avoid_: workspace folder, project directory

**Workspace folder**:
VS Code 的 `${workspaceFolder}`，即用户在编辑器中打开的根目录。它不等于 Unity project root；Unity 项目可以位于 Workspace folder 的子目录。

**Standalone mode**:
扩展激活但未检测到 Unity project root 时的运行模式。同文件内符号导航仍可用；跨文件跳转和 `#include` 解析禁用。
_Avoid_: degraded mode, no-project mode

**Canonical file identity**:
判断两个 file URI 或文件系统路径是否指向同一源码文件的跨平台语义。Windows 对路径大小写不敏感；默认 macOS volume 同时折叠大小写并统一 Unicode；Linux 保持大小写和 Unicode 差异。该身份不解析 symlink，也不会把归一化后的比较键当成可访问文件地址。
_Avoid_: URI spelling, canonical path

**Include chain**:
从一个源码文件出发递归跟随 `#include` 得到的可见文件集合。Definition、References、Hover、Completion、Signature Help 和 Document Highlight 对同一 Published indexed revision 使用相同的 Include chain；无法解析的 include 不会被猜测为可见文件。

### 符号与导航

**Declaration macro**:
通过宏调用声明变量、cbuffer 或 sampler 的模式，例如 `TEXTURE2D(_MainTex)`、`SAMPLER(...)` 和 `CBUFFER_START(...)`。内置模式与 `unityShaderNav.declarationMacros` 用户配置使用同一匹配语义。详见 [ADR-0003](docs/adr/0003-macro-pattern-whitelist.md)。
_Avoid_: declarative macro, macro declaration

**Reference macro pattern** / **Reference pattern**:
形如 `#pragma vertex $func` 或 `#pragma kernel $func`、需要把后续 token 视为函数引用的模式。它描述引用而非声明。

**Published indexed revision**:
一个 Workspace folder 已完整发布、可供一次请求读取的自洽索引代次。请求只能观察发布前或发布后的完整结果，不能混合正在构建的状态或不同代次的事实。

**Cold start**:
扩展激活后到每个 Workspace folder 首次拥有可用 Published indexed revision 之间的时间窗口。此时状态保持可观察；尚无可用结果的索引能力返回各自的中性结果，而不是无限等待。

**Rebuild mode**:
外部状态变化使增量更新不再可靠时，从源码重新构建索引的状态。已有 Published indexed revision 在构建期间继续服务；成功时完整替换，失败时保留 last-known-good 结果。

**Live document overlay**:
打开或未保存文档相对磁盘版本的最新编辑器内容。导航、补全、诊断等能力优先使用当前文档版本；关闭文档后恢复磁盘事实，没有磁盘版本时移除该文件。

**Published diagnostics**:
Problems 面板中与当前 Published indexed revision 和当前编辑器文档版本一致的诊断。过期异步结果不得覆盖新版本；关闭文档必须清除旧诊断。`unresolved-entry-point` 只在 pragma 引用没有保守可见的函数候选时报告；`srp-batcher-property`、`srp-batcher-property-type` 与 `srp-batcher-layout` 只在 SRP 和 material-cbuffer 事实充分时报告；`shader-graph-source-missing`、`shader-graph-invalid-precision-suffix` 与 `shader-graph-signature-mismatch` 只在精确、受信任且版本受支持的 Adapter graph 事实充分时报告。分支、多候选、宏展开或 Adapter 事实不足时保持中性。

**Multi-candidate Peek**:
同名符号有多个定义，例如预处理分支、多 Pass 同名或 HLSL overload 时，F12 返回全部保守候选，由 VS Code 原生 Peek UI 让用户选择。详见 [ADR-0001](docs/adr/0001-multi-candidate-peek-for-ambiguous-symbols.md)。

**Proximity tie-break**:
同一函数内多个同名局部声明都可见时，选择引用位置之前最近声明的消歧规则。跨文件或全局歧义不使用该规则删除候选。

**Chain lookup**:
struct 成员导航，例如 `surface.positionWS`，先推导 receiver 的声明类型，再沿类型与成员关系解析目标字段。

**Shader Graph Custom Function bridge**:
File 模式 Custom Function 节点与其 HLSL include 声明之间的 Adapter-backed 导航关系。Adapter 按受支持的 Shader Graph 版本产出 source、precision、port、range 与 provenance 等逻辑事实；Language Server 只验证精确 asset revision 和带 `_float` / `_half` 后缀的 HLSL signature，不解析或猜测 `.shadergraph` 序列化字段。
_Avoid_: Shader Graph parser, generated-code index

### 辅助能力

**Quick Documentation**:
光标悬浮时显示的项目声明、Package 声明或精选 Unity/HLSL/ShaderLab 文档。真实且可见的声明优先于精选兜底；只有已验证的 Unity Editor、Package 版本和来源事实才能决定兼容性，未知或不确定时保持中性。

**Built-in vocabulary**:
独立于项目索引的精选 Unity、HLSL 与 ShaderLab 领域词表，用于语义着色、Properties、Hover、Completion 和部分内置函数 Signature Help。它不是编译器完整标准库，也不承诺覆盖所有 render pipeline 或 Package 版本。
_Avoid_: standard library, compiler symbols

**Signature help**:
函数调用位置的参数提示。UnityShaderNav 只在能保守识别单行 free-function call 和候选函数元数据时返回；存在 overload-like 或预处理歧义时可以展示多个候选，而不会为得到唯一答案猜测分支状态。
_Avoid_: hover, function docs

**Declared Variant estimate**:
由当前 Shader 源码中的显式 keyword sets 静态计算出的 Variant 数量上界。它是理论估计，不是 Unity 编译或构建测量值；用户界面必须标为 `Declared/static`。
_Avoid_: compiled variants, build variants

**Compile candidates**:
Unity build 在 stripping 前报告的候选 Variant 数量。它只在 Editor Adapter 提供匹配 project、Unity version、build target 和 source identity 的 build evidence 时已知。
_Avoid_: declared variants

**Kept Variants**:
Unity build 在 stripping 后保留的 Variant 数量。失败或不完整的 build 可以只有 Compile candidates 而没有 Kept Variants；未知不能表示为零。
_Avoid_: used variants, declared variants

**Variant build evidence**:
Editor Adapter 提供的有界、聚合 build facts，按 Shader、Pass、Stage、build target 和 graphics API 绑定，并携带 project、producer、source revision 与 collection timestamp。它不进入 Published indexed revision，也不替代 Declared Variant estimate。
_Avoid_: variant estimate, compiler guess

## Flagged ambiguities

**"Package"**:

- ✅ Unity Package，例如 `com.unity.render-pipelines.universal`
- ❌ npm package；讨论扩展实现时需明确写出 npm

**"Reference"**:

- ✅ 符号引用，即 identifier 出现在使用点
- ❌ 引用类型；HLSL 没有对应的 C++/C# 语义

## 示例对话

> **TA**：“F12 在 `TransformObjectToHClip` 上跳到了 4 个地方，怎么回事？”
> **开发者**：“这是 Multi-candidate Peek。这个函数存在多个预处理分支版本；UnityShaderNav 不猜测激活分支，所以返回全部保守候选。”
> **TA**：“Rider 就跳一个啊。”
> **开发者**：“Rider 会根据 Shader Context 推断分支；UnityShaderNav 采用 ADR-0001 的保守多候选语义。”
>
> **TA**：“我 F12 在 `_MainTex` 上跳不到声明。”
> **开发者**：“如果声明是 `TEXTURE2D(_MainTex)`，它属于 Declaration macro。项目自定义宏需要加入 `unityShaderNav.declarationMacros`。”
