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

**Unity Editor Adapter**:
用户显式安装到 Unity project 的 Editor-only UPM package。它通过 project-local
descriptor、每次 Editor instance 新生成的 token，以及 Windows named pipe 或
macOS/Linux Unix domain socket，向同机同用户的扩展提供 Unity-only evidence。
同一 Unity project 的多个 Workspace folder 共享一个 authenticated stream；不同
project root 的 client、registry、token 与 evidence lifecycle 相互隔离。它不是远程
服务，不使用 TCP，也不进入 index lifecycle。
_Avoid_: remote service, TCP daemon, automatic project install

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
Problems 面板中与当前 Published indexed revision 和当前编辑器文档版本一致的诊断。过期异步结果不得覆盖新版本；关闭文档必须清除旧诊断。共享文件在 Auto 下只分析有显式上限的已知 Shader Context 集合；等价 finding 按 identity 合并并同时报告 affected/analyzed 数量，展开项保留精确 Context 与 static/compiler provenance。未分析、未知或不支持的维度显式为 `unverified`，不得解释为 passing。`unresolved-entry-point` 只在 pragma 引用没有保守可见的函数候选时报告；`srp-batcher-property`、`srp-batcher-property-type` 与 `srp-batcher-layout` 只在 SRP 和 material-cbuffer 事实充分时报告；`shader-graph-source-missing`、`shader-graph-invalid-precision-suffix` 与 `shader-graph-signature-mismatch` 只在精确、受信任且版本受支持的 Adapter graph 事实充分时报告。分支、多候选、宏展开或 Adapter 事实不足时保持中性。

**Multi-candidate Peek**:
同名符号有多个定义，例如预处理分支、多 Pass 同名或 HLSL overload 时，F12 返回全部保守候选，由 VS Code 原生 Peek UI 让用户选择。这是没有 Context 时的默认与兜底语义；选中 Variant Context 或 Shader Context 后，导航会选中该 Context 可证明 active 的候选，只有在证明不出任何 active 候选时才退回全部保守候选。详见 [ADR-0001](docs/adr/0001-multi-candidate-peek-for-ambiguous-symbols.md) 与 [ADR-0009](docs/adr/0009-context-matrix-semantics-preserving-multi-candidate-peek.md)。

**Proximity tie-break**:
同一函数内多个同名局部声明都可见时，选择引用位置之前最近声明的消歧规则。跨文件或全局歧义不使用该规则删除候选。

**Chain lookup**:
struct 成员导航，例如 `surface.positionWS`，先推导 receiver 的声明类型，再沿类型与成员关系解析目标字段。

**Shader Graph Custom Function bridge**:
File 模式 Custom Function 节点与其 HLSL include 声明之间的 Adapter-backed 导航关系。Adapter 按受支持的 Shader Graph 版本产出 source、precision、port、range 与 provenance 等逻辑事实；Language Server 只验证精确 asset revision 和带 `_float` / `_half` 后缀的 HLSL signature，不解析或猜测 `.shadergraph` 序列化字段。
_Avoid_: Shader Graph parser, generated-code index

**C# Property evidence**:
Adapter 提供的 ShaderLab Property 与 C# `Material` / `MaterialPropertyBlock`
Set/Get 调用之间的会话级证据。可信引用必须具有已证明的 Shader 绑定、常量 Property
名称来源、有限 accessor 类型和仍匹配的当前 C# 源码；常量
`Shader.PropertyToID` 只传递名称 identity，不把运行时整数 ID 当作稳定契约。
仅名称绑定和动态表达式必须保留为 uncertain evidence，不能成为安全 Rename edit。
该证据不进入源码索引或缓存，也不构成通用 C# language tooling。
_Avoid_: C# symbol index, numeric property ID contract

**Safe cross-asset Property Rename**:
用户显式触发的 Shader Property 事务式重命名。Preview 按 Shader/HLSL source、
proven C# source 与 serialized Material assets 分组并保留 provenance；Apply 必须
重新验证 preview identity，先 prepare Material transaction，再应用 exact-old-text
source edits，最后 commit。动态/仅名称证据、只读 Package、source/revision conflict
或不完整 Adapter scope 都是 blocker；取消或失败必须显式 rollback。
_Avoid_: best-effort rename, partial success

### 辅助能力

**Quick Documentation**:
光标悬浮时显示的项目声明、Package 声明或精选 Unity/HLSL/ShaderLab 文档。真实且可见的声明优先于精选兜底；只有已验证的 Unity Editor、Package 版本和来源事实才能决定兼容性，未知或不确定时保持中性。

**Built-in vocabulary**:
独立于项目索引的精选 Unity、HLSL 与 ShaderLab 领域词表，用于语义着色、Properties、Hover、Completion 和部分内置函数 Signature Help。它不是编译器完整标准库，也不承诺覆盖所有 render pipeline 或 Package 版本。
_Avoid_: standard library, compiler symbols

**Signature help**:
函数调用位置的参数提示。UnityShaderNav 只在能保守识别单行 free-function call 和候选函数元数据时返回；存在 overload-like 或预处理歧义时可以展示多个候选，而不会为得到唯一答案猜测分支状态。
_Avoid_: hover, function docs

**Portability report**:
针对一个打开的自定义 `.shader` 与用户选择的 render pipeline 或 graphics
profile，从同一 Published indexed revision 的精确源码、Unity Editor 版本和
已解析 Package 版本生成的解释性报告。Finding 只分为 mechanical change、
human rewrite、unsupported semantic 与 verification requirement；只有对该精确
源码机械证明的 edit 才能成为 Quick Fix。静态报告和编译成功都不声明渲染等价。
_Avoid_: shader converter, automatic migration, compatibility guarantee

**Compiler evidence view**:
为一个已选择、经 Unity Editor Adapter 验证的 Shader Context 展示 Source、
Preprocessed 和 Generated 三种视图。Preprocessed/Generated 是会话内虚拟文档，
携带 Context、compile profile、Unity/Adapter 版本和 source revision provenance；
源码 hash 改变后旧视图保留但标为 `STALE`，不再参与导航。
_Avoid_: decompiled shader, indexed generated source

**Source mapping gap**:
编译器文本中没有可靠双向 source mapping 的可见区域，例如宏展开、Unity 生成代码、
未知或有歧义的 `#line` source identity。Gap 不会被邻近行或文件名启发式填补。
_Avoid_: approximate mapping, best-effort location

**Material Context**:
连接的 Unity Editor 中当前选中持久化 Material 的资产级证据，包含其 Shader、可用时的
SubShader/Pass、序列化 Properties、textures、Material keywords 与 Adapter
provenance。证据同时绑定 project、Editor instance、Material/Shader content hash
和 Published indexed revision；它可以标注或排序候选，但不删除保守结果，也不进入索引或缓存。
Material Context 不是最终 draw Context；在真实 draw 证据到达前，global 与
engine-added keywords 必须保持 `UNKNOWN`。
_Avoid_: draw Context, runtime variant

**Pass selection observation**:
Material Context 对当前 Material 所报告 Shader/SubShader/Pass 的只读资产级事实。
它回答“报告选中了什么”，即使缺少 Shader Context 或 Adapter selection-decision
仍可成立；它不回答 Unity 为什么选择该 Pass，也不能单独成为 causal claim。
_Avoid_: Pass selection cause, runtime draw decision

**Pass causal explanation**:
对唯一问题 “Why was this Pass selected for the current Material Context?”
给出的证据约束结论。只有 Adapter-authored selection-decision 同时连接 exact
Material Context、Shader Context 与 source Pass，且 project、Editor instance、
Shader/Pass/stage/entry、source revision 和 provenance 身份链闭合无矛盾时才为
`supported`；该 decision 还必须携带实际触发的 versioned rule、summary 与非空
facts，身份相等本身只证明“选了什么”，不证明“为什么”。否则必须明确列出
missing/contradictory evidence 并 `refused`。
Variant、compiler 与 generated-source 只能作为精确链接的 corroboration，不能补出
selection-decision。详见 [ADR-0014](docs/adr/0014-evidence-constrained-current-pass-explanation.md)。
_Avoid_: inferred Pass cause, best-effort explanation

**Selection-decision evidence**:
Unity Editor Adapter 通过独立版本化 `pass-selection-decision/v1` capability
明确产出的 Material-to-Shader-Context-to-source-Pass 决策边。它保留 decision、
selection、Program、Material/Shader revision、Context、Adapter 会话身份，以及
实际触发规则的 versioned rule ID、summary 与 named facts。
Material Context 的
`selectedProgram`、名称/索引相等、源码 hash、compiler output 或 generated source
都不能派生或替代这条边。
_Avoid_: inferred selection edge, matching-pass decision

**Visual Lab**:
用户显式打开、仅在当前会话存在的持久 Webview。用户通过 **Use Current Selected
Material** 同时 pin 当前持久化 Material 与一个 Published Shader include-point
Context，再分别手动请求 Before 和 After 的真实 Unity 64x64 离屏渲染。它不自动跟随
Unity selection，不连续渲染，也不修改 Shader 或 Material。
_Avoid_: live preview, Scene preview, automatic Shader repair

**Pinned Visual Lab target**:
Visual Lab 一次显式选择所冻结的完整 render identity：selection 和 publication、
Material/Shader asset revision、最终 Shader Context 与 keywords、render pipeline、
graphics profile、color space、Unity/Adapter/project/instance，以及 repository-owned
render input。任一维度变化都立即取消在途请求；旧帧只可带原 provenance 以 `STALE`
保留，用户必须重新 pin，不能静默采用新 identity。
_Avoid_: current Unity selection, best-effort refresh

**Visual Lab frame evidence**:
一次单独 Before 或 After 请求的会话级证据，包含完整 Pinned Visual Lab target、
request generation、capture timestamp、PNG bytes/hash 和独立 NaN/Inf mask。Before
与 After 各自拥有完整 provenance；像素相似不代表 identity 相同或验证通过。证据不进入
Published indexed revision、cache、workspace/global storage 或 telemetry。
_Avoid_: screenshot, persisted render result, image-diff proof

**NaN/Inf mask**:
从 Unity float render target、在生成展示 PNG 之前精确读取的 top-left row-major R8
mask。每像素恰好一个 byte；任一原始 channel 为 NaN 或 Infinity 时为 `255`，否则为
`0`，同时包含可由 mask 精确核对的 NaN、Infinity 与 masked pixel counts。它不是
Before/After image diff；同一像素同时含两类时 NaN 优先。
_Avoid_: heatmap diff, tolerance-based diagnostic

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

**Shader Variant budget**:
仓库版本化的 declared 或 kept Variant 上限与 baseline delta 合约，可按 Shader、
Pass、Stage、build target 和 graphics API 选择 Context。Declared 只来自当前源码的
静态上界；Kept 必须来自 source hash 匹配且 completed 的 build evidence。缺失证据是
`unverified` 并使门禁失败，不能解释为 0 或 pass。
_Avoid_: best-effort budget, missing-evidence pass

**Shader compile contract**:
仓库选择的 Shader scopes、必需 Adapter/profile capabilities、compiler warning
baselines、SRP Batcher requirements、Variant budgets 与明确 unverified CI policy
的版本化合约。不同 evidence class 保持独立，缺少某类证据不能由另一类替代。
_Avoid_: best-effort compile check, missing-evidence pass

**GPU capture evidence**:
版本化、受限的 Adapter evidence，把一个 captured draw 绑定到 capture/tool/GPU/
driver/project provenance、Shader Context、asset GUID/source revision 与精确
source range。真实 capture 还要独立匹配 trace hash/size/label。asset 或 source
漂移后是 `stale`，replay/trace 环境不兼容是 `unavailable`，缺少可靠 line map
是 `unmapped`；raw `.gputrace` 不属于仓库事实。
_Avoid_: trace guess, generated-text source match

## Flagged ambiguities

**"Package"**:

- ✅ Unity Package，例如 `com.unity.render-pipelines.universal`
- ❌ npm package；讨论扩展实现时需明确写出 npm

**"Reference"**:

- ✅ 符号引用，即 identifier 出现在使用点
- ❌ 引用类型；HLSL 没有对应的 C++/C# 语义

## 示例对话

> **TA**：“F12 在 `TransformObjectToHClip` 上跳到了 4 个地方，怎么回事？”
> **开发者**：“这是 Multi-candidate Peek。没有选中 Context 时，UnityShaderNav 不猜测激活分支，所以返回全部保守候选。”
> **TA**：“Rider 就跳一个啊。”
> **开发者**：“选一个 Variant Context 或 Shader Context 就也是跳一个：能证明 active 的候选会被选中。区别在于 UnityShaderNav 只在证得出来的时候收窄，证不出来就退回全部候选，而不是猜。”
>
> **TA**：“我 F12 在 `_MainTex` 上跳不到声明。”
> **开发者**：“如果声明是 `TEXTURE2D(_MainTex)`，它属于 Declaration macro。项目自定义宏需要加入 `unityShaderNav.declarationMacros`。”
