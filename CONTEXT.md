# UnityShaderNav

VSCode 扩展，为 Unity Shader 文件（ShaderLab + HLSL）提供代码导航。本文件只定义稳定的领域术语与推荐命名；实现拓扑见 `docs/architecture.md`，可变状态与工作项见 GitHub Issues。

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
从某文件出发递归跟随 `#include` 形成的传递闭包文件集合。每个 **Published indexed revision** 持有一份 Include chain 行为，组合该 revision 的 immutable index view、settings、**PackageContext** 与 include resolver；Definition、References、Hover、Completion、Signature Help 和 Document Highlight 必须消费这同一份可见性解释。默认不跨请求 memoize，已捕获的旧 revision 不读取新 revision 的索引或配置事实。

### 符号收集

**Declaration macro**:
通过宏调用声明变量 / cbuffer / sampler 的模式（如 `TEXTURE2D(_MainTex)`、`SAMPLER(...)`、`CBUFFER_START(...)`）。Macro pattern recognizer 集中校验、编译并匹配内置白名单与用户配置，只向索引器返回符号种类、捕获名称和范围；编译后的 pattern 不越过该 Module 边界。详见 ADR-0003。
_Avoid_: declarative macro, macro declaration

**Reference macro pattern** / **Reference pattern**:
形如 `#pragma vertex $func` / `#pragma kernel $func` 等需要把后续 token 当作函数引用处理的模式。与 declaration macro 由同一个 Macro pattern recognizer 解释，但只投影函数引用名称和范围；结构 sentinel 过滤、内置 declaration macro head 的 lexical role 与 cache identity 也由该 Module 从同一组事实派生。

**Symbol entry**:
索引中的一条记录。键为符号名，值为 `SymbolEntry[]`（多个候选共存——见 ADR-0001）。
_Avoid_: symbol record, symbol info

**Scope range**:
`SymbolEntry` 的字段，描述该符号在哪段文本范围内可见。全局符号 = 整个文件；函数参数 / 局部变量 = 所属函数体范围。用于 shadowing 判定和 Find References 的位置过滤。

**Proximity tie-break**:
同函数内多个同名局部变量声明（如不同 block scope 里重复用 `temp`）的候选消歧策略——返回引用位置之前最近的可见声明。Definition、Hover、Chain lookup 与 Project-index suggestion 必须通过同一个 index-owned Symbol entry selection Module 解释 **Scope range**、声明顺序、Include chain 可见性和局部遮蔽；全局歧义继续保留全部候选。

**Document analysis**:
`DocumentAnalysis` 是从一份完全匹配的 ShaderLab 源码快照派生出的不可变事实：按源码顺序排列的 HLSL/CG blocks、同一份多行 comment/string/brace policy 下的 ShaderLab structure、Shader/Pass 声明及 Fallback/UsePass 引用事实、SRP 证据及 `UnityPerMaterial` 布局事实，以及 full analysis 才包含的可选 ShaderLab lexical tokens。`FileIndex` 持久投影 structure、ShaderLab name facts 与 material-contract facts，分别供 Outline、项目级名称查询、Diagnostics 和 Code Actions 使用，但不持有 analysis 容器或 source text。磁盘和其他 index-only 路径只临时构造并立即丢弃 analysis；只有当前 open-document attempt 的 full analysis 与对应 **Published indexed revision** 同寿命，供 Semantic Tokens 复用。文档关闭或 attempt 被替换时，下一 revision 不再持有它；已捕获的旧 revision 仍保持自洽，直到其 reader 释放。Analysis 容器本身不进入磁盘索引记录、manifest、持久化缓存或进程级缓存。
_Avoid_: document cache, parse cache, global analysis cache

### 索引生命周期

**Cold start**:
扩展激活后到各 Workspace 首次发布索引之间的时间窗口。`RequestSuspender` 只在 Server 读取全局设置与初始 folder snapshot、启动 per-root initialization 之前，通过 handler Adapter 提供一个短暂、有上限的请求门；status request 始终绕过它。释放后，没有 published revision 的索引请求直接返回 neutral result，不等待该根完成扫描。Workspace folder event、scoped settings reconfiguration、watcher transaction 与 rebuild 不使用该请求门。

**Rebuild mode**:
外部状态变化使增量更新不再可靠时，Workspace 从零构建 candidate revision 并重新发布的状态。已有 published revision 在构建期间继续服务；成功时单次替换，失败时继续保留 last-known-good revision。区别于从当前 revision fork 的单文件增量路径。生产 lifecycle 只通过 WorkspaceFolderCoordinator、scoped settings reconfiguration 和 watcher-triggered transaction 进入这些行为，不保留仅测试可见的平行入口。

**PackageResolver**:
启动时读 `Packages/packages-lock.json`，构建 `package_name → physical_path` 映射的服务。是 ADR-0002 manifest-driven 策略的实现承担者。

**PackageContext**:
candidate 与 published revision 中 package 相关能力的边界：组合 **PackageResolver**、include 解析上下文、package 成员关系，以及从 package manifest 优先获得的不可变 version/source facts。完整 candidate construction 创建它，并与索引数据一起发布；与 **PackageResolver** 成对理解，另见 Flagged ambiguities 的 "Package"。

**Unity project facts**:
从 `ProjectSettings/ProjectVersion.txt` 捕获、随 **Published indexed revision** 原子发布的 Editor version 事实。版本缺失或格式未知时保持 unknown；Quick Documentation 只消费明确验证过的 major/minor，不从当前日期或文档 URL 猜测兼容性。它不属于 **PackageContext**。

**Indexed source membership**:
一个 **Published indexed revision** 对可进入磁盘索引的源码集合所持有的不可变事实。完整 **Indexed revision candidate construction** 从 settings、Unity root 与 **PackageContext** 构造它；cold start 发现、warm restore、file watcher 准入和文档关闭后的磁盘回落必须消费同一事实。它统一文件扩展名、用户排除规则、已解析 Package roots 及 Package 的 `Documentation~` / `Samples~` 边界；**PackageContext** 仍只负责 Package 解析与成员关系，`Workspace` 仍只负责 lifecycle 与 publication。
_Avoid_: cache restore eligibility, watcher scope helper, duplicated source filter

**WorkspaceIndex**:
revision candidate 内部的可变索引实现。它维护磁盘索引、打开文档覆盖、全局符号和全局引用之间的一致性；增量 candidate 通过 copy-on-write fork 获得独立 maps / global arrays，并复用不可变 `FileIndex` 值。发布后该实例不再变更；请求 handler 和公开 Workspace behavior 都不暴露它的 stores。

**Indexed Workspace interface**:
请求与文档生命周期使用的行为接口。它包含打开文档更新、关闭文档，以及 Diagnostics、Code Actions、Definition、References、Hover、Completion、Signature Help、Document Highlight、Document Symbols、Semantic Tokens 和 Workspace Symbols 等 index-backed 查询；`Workspace` 在接口后组合 revision publication、include 可见性、Package 过滤与符号解析。handler 只做 LSP 参数和 neutral-result 适配。
_Avoid_: index bundle, store context, workspace index facade

**Published indexed revision**:
单个 Workspace 已发布、可被一次请求捕获的不可变查询视图。它把 settings、Unity root、Package context、**Indexed source membership**、cache fingerprint、live-document attempt identity 和索引数据绑定为同一代；异步查询始终使用捕获的同一个 revision，不会混读 candidate 或另一代 stores。
_Avoid_: current store, live index object, mutable workspace index

**Published diagnostics**:
Problems 面板中的诊断是 **Published indexed revision** 对当前 open-document attempt 的派生输出，而不是独立可变真相。异步结果只有在 Workspace owner、revision、openId 与 version 仍全部匹配时才可发送；每次新 publication 都刷新其所有打开文档，关闭文档必须发送空集合清除旧诊断。`unresolved-entry-point` 只证明 pragma 引用在保守可见性模型中存在函数候选；`srp-batcher-property`、`srp-batcher-property-type` 与 `srp-batcher-layout` 只在 SRP 证据和精确 material-cbuffer facts 足够时报告。分支、多候选或宏展开不确定时保持中性。
_Avoid_: diagnostic cache, best-effort stale Problems

**Indexed revision candidate**:
尚未发布的一次性可变 builder。初始化、rebuild、recovery 和 warm cache restore 通过同一个 **Indexed revision candidate construction** 显式取得完成的 disk/package baseline；live document、close 和 watcher transaction 从 published revision fork。Workspace 随后把最新 open-document desired state replay 到隔离 candidate，完成所有 parse / I/O / attempt 校验后才构造新 published revision，并通过一次同步 pointer swap 生效；失败 candidate 直接丢弃。
_Avoid_: staging store exposed to handlers, partial revision

**Indexed revision candidate construction**:
完整索引 transaction 的内部 Module。它负责 Unity root 检测、**PackageContext** 创建、parser readiness 与 runtime identity、cache compatibility / restore、source discovery，以及兼容的 retain-or-fail policy，并显式返回一个完成但未发布的 **Indexed revision candidate**。Cold start、warm restore、rebuild 和 recovery 由 request data 与可用 cache state 驱动，但不分叉 transaction policy。它不保存 candidate 到 `Workspace`，不拥有 open-document desired state、lifecycle、revision、publication、pointer swap 或 cache persistence。
_Avoid_: staged candidate handoff, phase-only bootstrap, synthetic empty candidate

**Open document snapshot**:
一次编辑器文档状态的不可变值：`uri + languageId + text + openId + version`。`openId` 标识一次 `didOpen → didClose` 会话；`version` 只在同一 `openId` 内排序。两者共同构成 document attempt identity。
_Avoid_: document generation, text document reference

**Live document overlay**:
打开或未保存文档覆盖在磁盘索引之上的索引记录。edit 只允许最新 document attempt 发布；close 在 candidate 中恢复最后有效的磁盘记录，没有磁盘版本时删除该 URI，随后原子发布。等价 file URI 共用一个 identity；一个 snapshot 只属于最长路径匹配的 Workspace，根拓扑变化时在旧、新 owner 之间迁移；没有新 owner 时，下一次需要该打开文档的 index-backed 请求可以重新进入 lazy routing。
_Avoid_: temporary index, unsaved cache

**Parser runtime assets**:
一次成功的 parser readiness attempt 所解析并加载的不可变运行时事实。它明确区分 source、tsc-out、copied-server 和 bundled-server 四种布局，把 vendored HLSL grammar 读成进程稳定的 bytes 与 content identity；Parser 执行和 cache compatibility 必须消费同一个事实。未知布局、缺失或无法加载的 grammar 是可观察的 parser initialization failure，不能猜路径、写 sentinel fingerprint 或恢复缓存。失败 attempt 可在同一进程修复后重试；一旦成功，该进程不再从磁盘重新解释 grammar。
_Avoid_: grammar path guess, wasm fallback, parser asset cache

**Runtime artifact graph**:
canonical repository root 下 Extension runtime 产物的唯一装配事实。它声明 extension/server bundles、copied server、grammar/provenance/license、完整 `web-tree-sitter` runtime、watch inputs、package required entries、Electron staging roots 与四种 **Parser runtime assets** 布局。标准 build 通过它完成一次装配并写入内容寻址 manifest；current-run packaging 同时验证构建输入、磁盘输出与 VSIX 内字节。npm scripts 仍是唯一命令 Interface。
_Avoid_: packaging file list, watch asset list, Electron runtime copy list

**Index implementation identity**:
实际生成 `FileIndex` 的 server、resolved shared/runtime packages 与成功加载的 exact grammar bytes 的内容身份。它是 cache fingerprint 的一部分；identity 不同或无法确定时只能从源码重建，不能恢复可能由另一套索引语义产生的记录。
_Avoid_: cache version, release version, Git revision

**Cache workspace identity**:
用于选择和验证持久化缓存分桶的 canonical Workspace folder URI。它复用 Workspace ownership 的 file-URI 规范化规则：等价 Windows drive-letter URI 命中同一 identity，父子 Workspace 即使指向同一个 Unity project root 也保持不同 identity。Manifest 的 Unity root 比较和同进程保存协调使用平台 filesystem path identity，不能由 Windows 路径大小写分叉。Unity 模式的最终 manifest 位于 `Library/UnityShaderNavCache/workspaces/<identity-hash>/index.json`；每个 identity 仍只有一个 monolithic manifest。
_Avoid_: Unity project cache identity, session id, index revision

**Latest-pending cache persistence**:
`CacheManager` 以最终 manifest path 为键、在一个 language-server process 内协调保存。每个 path 最多有一个 active request 和一个 latest pending request；新请求替换旧 pending payload 并继承其 waiters，因此可合并中间状态而不丢失进程内最新请求。Active failure 不阻塞 pending drain；replacement failure 通过原子 rename 语义保留此前有效 manifest。不同进程之间只有文件有效性的原子保证，没有 latest-request 全序承诺。
_Avoid_: cache revision queue, cross-process latest revision, global cache generation

**Index revision**:
单个 `Workspace` 在一次 language-server session 内成功发布的索引代次。`0` 表示从未发布；初始化、rebuild、有效 watcher batch、live edit、close 或兼容的 settings-only 变更每次成功发布都单调递增一次；空事件批次、没有有效变化的 watcher transaction，以及过期、已被取代或失败的 attempt 不发布、不递增。读取索引状态的 request 捕获一个 immutable revision；纯词法 early exit 和没有 serving revision 的 neutral result 不读取 revision。它不是时间戳，也不等于 status sequence。
_Avoid_: index version, cache generation, status sequence

**Serving workspace**:
请求路径按 URI 找到、且当前拥有可服务 published revision 的 `Workspace`。它可以处于 `ready`，也可以在 rebuild/recovery 或 failed 状态下服务 last-known-good revision。该查询不等待初始化、不创建 Workspace；没有 serving workspace 的 handler 立即返回对应的 neutral LSP result。当前打开文档需要恢复已消失的 owner 时，request router 使用独立、受 `openId` 约束的 lazy-create 路径。
_Avoid_: ready promise, lazy request workspace

**Index status snapshot**:
当前所有 Workspace folder 的完整、按根排序的状态快照。每个根同时报告 `unity` / `standalone` mode 与 `indexing` / `ready` / `failed` lifecycle；server 同时提供 pull request 和 full-snapshot changed notification，避免 client 因错过通知而停留在旧状态。
_Avoid_: mode notification, readiness flag, status delta

**Status sequence**:
`WorkspaceManager` 在一次 LSP session 内为 index status snapshot 分配的单调递增顺序号。根新增、移除或 lifecycle 变化时递增；client 重连时重置 last-seen sequence。它排序状态快照，不标识索引数据。
_Avoid_: index revision, workspace generation

### 跳转行为

**Multi-candidate Peek**:
同名符号有多个定义（#ifdef 分支、多 Pass 同名、HLSL overload）时，F12 返回所有候选，由 VSCode 原生 Peek UI 让用户挑选。是本扩展与 Rider Shader Context Picker 的关键差异——详见 ADR-0001。

**Chain lookup**:
struct 成员 F12（如 `surface.positionWS`）的解析过程——先推导 receiver 的声明类型，再沿类型与成员关系解析目标字段。

### 补全与签名

**Cursor context**:
由 `analyzeCursor()`（`server/src/parser/lexical/cursor.ts`）统一产出的"光标处词法信息"结构：当前 word、member access（导航用）、词法态（code/comment/string）、补全分类（HLSL/ShaderLab/semantic/state-value）、补全前缀与 member 补全上下文。完整分析以 `analyzeCursor` 为主入口；`classifyCursor` 和不带语言门控的 `memberAccessAt` 是两个窄派生接口，其余词法 helpers 属于 Module 内部实现。
_Avoid_: lexical state, parser context

**Documentation target**:
由 **Cursor context** 和同一份文档词法 tokens 精确推导的悬浮目标；区分 ShaderLab term、render-state value、Property attribute/type、HLSL semantic 与普通 HLSL identifier，并在 comment/string 或角色不匹配时保持中性。它表达“光标指向什么”，不负责挑选文档内容。

**Documentation resolver**:
每个 **Published indexed revision** 持有的 Quick Documentation 解析器。它先使用项目或 include-visible Package 的真实声明及该 revision 的 Package provenance；只有不存在真实声明时，才按 **Documentation target**、官方 package source、resolved manifest version 和 include visibility 选择精选兜底。未知、fork/local 或版本不兼容事实不会被猜测成官方兼容性。

**ShaderLab layout analysis**:
同一份精确 `.shader` source snapshot 的轻量、lossless 结构事实：记录 Shader/Properties/SubShader/Pass direct scope、逐行确定性缩进深度、完整 embedded program/include 保护区，以及显式 safety/issues。Outline structure 是它的兼容投影；snippet 与 formatter 只消费 safe layout，不从 handler 重新扫结构。

**ShaderLab literal color fact**:
Properties scanner 对 `Color` Property 默认值的窄事实：精确 tuple range、四个有限数字分量与 HDR decorator 状态。Document Color 只投影非 HDR 且全部位于 `[0,1]` 的事实；Color Presentation 必须重新匹配当前 exact range，禁止 clamp 或 Gamma/Linear 猜测。

**Suggestion context**:
补全/签名帮助请求位置的粗粒度上下文分类，例如 HLSL code、ShaderLab code、semantic position、ShaderLab state value、comment、string。用于避免把 ShaderLab 状态词塞进普通 HLSL 表达式，或在注释/字符串里返回建议。现在它是 **Cursor context** 面向补全的投影——即由 `classifyCursor` 产出的 `kind`/`prefix`/`member` 子集。
_Avoid_: completion mode, parser state

**Project-index suggestion**:
从当前文件索引、include-visible 文件索引、作用域信息和 chain lookup 推导出的补全或签名候选。每个 **Published indexed revision** 固定持有一个只读 candidate selector；Completion、member completion 和 Signature Help 只提交查询意图，由 selector 统一负责可见性、最近声明、当前文件/include 排名、成员类型推导、去重、保守 overload 候选与 project-over-built-in 优先级。
_Avoid_: autocomplete symbol, completion cache

**Built-in vocabulary**:
独立于 parser 和 suggestion 展示形态的精选 Unity/HLSL/ShaderLab 领域词表。词条携带稳定的 ShaderLab keyword、render state、state-value context/value 和 Property type 角色；解析衍生的语义着色、Properties、hover、补全和部分内置函数签名帮助只通过中立的精确查询、上下文投影、词法角色和类型转换接口消费这些事实。它不是编译器完整标准库，也不应该假装覆盖所有 pipeline/package 版本。
_Avoid_: standard library, compiler symbols

**Signature help**:
LSP 的函数调用参数提示。UnityShaderNav 只在能保守识别单行 free-function call 和候选函数元数据时返回，遇到 overload-like 或预处理歧义时可以返回多个候选；当前参数指向第一个参数数量足够的候选，但不会因此删除其他保守候选。
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
> **开发者**："Rider 会用 Shader Context Picker 推断激活分支；UnityShaderNav 采用 ADR-0001 的保守多候选语义。"
>
> **TA**："我 F12 在 `_MainTex` 上跳不到声明。"
> **开发者**："看一下声明长什么样——如果是 `TEXTURE2D(_MainTex)`，这是 declaration macro，需要白名单识别。它是不是项目自定义的宏？"
> **TA**："对，我们包了一层 `MY_TEX2D(...)`。"
> **开发者**："在 `unityShaderNav.declarationMacros` 里加上你的模式就行。"
