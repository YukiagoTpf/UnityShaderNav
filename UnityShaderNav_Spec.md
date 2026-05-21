# UnityShaderNav - Technical Spec

> 本 spec 经过一轮设计访谈后已大幅修订。关键架构决策另见 `docs/adr/`，术语见 `CONTEXT.md`。

## 1. 背景与目标

### 问题

在 VSCode 中编辑 Unity Shader 文件时，缺乏可用的跳转功能。现有的 Omni Shader 扩展将 Go to Definition / Find References 等核心导航功能锁在 $99 付费版本中。Rider 虽然支持完整的 Shader 跳转，但作为 TA 日常工作不需要其重量级 IDE 的全部能力，且 Rider 的 AI 辅助生态不如 VSCode。

### 目标

开发一个 VSCode 扩展 **UnityShaderNav**，提供 Unity Shader 文件（ShaderLab + HLSL）的代码导航能力，核心聚焦 **Go to Definition** 和 **Document Symbols**，达到 Rider **基础**跳转功能的体验。

### 非目标

- 不做代码补全（Code Completion）
- 不做实时错误诊断（Diagnostics）
- 不做代码格式化（Formatting）
- 不做 Shader 编译/预览
- 不实现宏展开（见 ADR-0003，靠 declaration / reference 模式白名单替代）
- 不实现 Rider 的 Shader Context Picker（见 ADR-0001，靠多候选 Peek 替代；P2 可加）
- 不做 ShaderGraph 生成代码的索引
- 不做 Compute Shader 与 C# 侧 dispatch 调用的跨语言跳转
- 不做 Surface Shader 隐式注入参数（`Input`、`SurfaceOutput*`）的支持

---

## 2. 支持的文件类型

| 后缀 | 说明 | 支持度 |
|---|---|---|
| `.shader` | ShaderLab 文件（包裹 HLSL/CG 代码块） | 完整 |
| `.hlsl` | 纯 HLSL 文件 | 完整 |
| `.cginc` | Unity CG Include 文件 | 部分（HLSL 为主，CG 特有语法走 declaration macro 白名单兜底） |
| `.hlslinc` | HLSL Include 文件 | 完整 |
| `.compute` | Compute Shader | 完整（`#pragma kernel` 走 reference pattern） |

CG 支持的明确范围：可识别 `sampler2D`/`fixed4` 等 CG 声明语法（通过 declaration macro 白名单），可跳转 UnityCG.cginc 系列 include 路径。明确不支持：Surface Shader 自动注入的隐式参数；`#pragma surface` 模式特有的代码生成。

---

## 3. 功能清单与优先级

### P0 - MVP（必须通过）

| 功能 | 说明 |
|---|---|
| 函数调用 → 函数定义 | F12 跳到函数声明/实现处 |
| 变量使用 → 变量声明 | F12 跳到变量定义处（含通过 declaration macro 声明的变量） |
| 函数参数 → 参数声明 | F12 在参数 identifier 上跳到所属函数的参数列表 |
| 局部变量 → 局部声明 | F12 跳到当前函数内的声明（同名 shadowing 走 proximity tie-break） |
| `#include` → 打开文件 | F12 在 include 路径上直接打开目标文件 |
| `#pragma vertex/fragment/kernel/...` 入口 | F12 在入口函数名上跳到该函数定义 |
| 跨文件跳转 | 通过 include chain 跳转到其他 .hlsl/.cginc 文件中的定义 |

### P1 - MVP+（加分项）

| 功能 | 说明 |
|---|---|
| struct 成员 → struct 定义 | F12 在 `.positionWS` 上跳到 struct 中该字段声明；chain lookup 支持到 L3（参数 / 局部变量 / 带初始化的声明 / 函数返回值） |
| 宏使用 → `#define` | F12 在宏名上跳到 define 处 |
| Document Symbols | Ctrl+Shift+O 显示当前文件的函数/struct/cbuffer/pragma 入口大纲 |
| Find References | Shift+F12 查找符号的所有引用位置；默认范围 user files；通过配置 `unityShaderNav.findReferences.includePackages` 切换是否包含 Packages |

### P2 - 后续迭代

| 功能 | 说明 |
|---|---|
| ShaderLab Properties ↔ HLSL 变量映射 | Properties 声明与 HLSL 中同名变量的双向跳转 |
| Hover 信息 | 悬停显示函数签名、变量类型 |
| Workspace Symbol Search | Ctrl+T 全局符号搜索 |
| Shader Context Picker | 类似 Rider，分析 multi_compile 集合后在多候选里指定默认活跃分支 |
| struct chain lookup L4 | 数组元素 / 嵌套字段 / cbuffer 内 struct 的 chain lookup |

---

## 4. 技术架构

### 4.1 整体架构

```
VSCode Extension (TypeScript)
├── Extension Client (vscode-languageclient)
│   └── 注册文件类型、激活条件、配置项
└── Language Server (vscode-languageserver, 独立进程)
    ├── ShaderLab Parser (轻量状态机)
    │   └── 识别 HLSLPROGRAM/CGPROGRAM/HLSLINCLUDE/CGINCLUDE 块边界
    ├── HLSL Parser (tree-sitter-hlsl)
    │   └── 生成 AST，提取符号
    ├── Macro Pattern Recognizer
    │   └── 内置 + 用户配置的 declaration / reference 模式白名单（ADR-0003）
    ├── Symbol Index (符号表)
    │   ├── 正向索引: Map<name, SymbolEntry[]>
    │   ├── 反向索引: 每文件 ReferenceEntry[] + lazy 全局 name→refs map
    │   └── 文件级 scope（含 scopeRange、declaredType 等元信息）
    ├── PackageResolver
    │   └── 读 Packages/packages-lock.json，构建 package_name → physical_path 映射（ADR-0002）
    ├── Include Resolver
    │   └── 相对路径 / Packages 虚拟路径 / includeDirectories / 大小写敏感 + fallback
    ├── Cache Persistence
    │   └── 序列化到 Library/UnityShaderNavCache/（ADR-0004），standalone 模式降级到 globalStorageUri
    └── LSP Handlers
        ├── textDocument/definition
        ├── textDocument/references
        └── textDocument/documentSymbol
```

### 4.2 技术栈选择

| 组件 | 选择 | 理由 |
|---|---|---|
| 扩展语言 | TypeScript | VSCode 原生生态，AI 辅助生成效率最高 |
| LSP SDK | vscode-languageserver-node | 微软官方，文档完善 |
| HLSL 解析 | tree-sitter-hlsl (WASM) | MIT 开源，增量解析，性能好 |
| ShaderLab 解析 | 自写状态机 | ShaderLab 外层结构简单，不需要完整 parser |
| 包管理 | npm | 标准 |

### 4.3 参考实现

| 项目 | 参考价值 |
|---|---|
| [Gaijin Dagor Language Server](https://github.com/GaijinEntertainment/Dagor-Shader-Language-Server) | TypeScript LSP 架构、HLSL 符号收集逻辑 |
| [tree-sitter-hlsl](https://github.com/tree-sitter-grammars/tree-sitter-hlsl) | HLSL 语法解析核心 |
| [pema99/UnityShaderParser](https://github.com/pema99/UnityShaderParser) | ShaderLab 语法规则参考 |
| [antaalt/shader-sense](https://github.com/antaalt/shader-sense) | tree-sitter query 提取符号的模式参考 |
| [tgjones/HlslTools](https://github.com/tgjones/HlslTools) | shadertoolsconfig.json 配置方案、include 解析策略 |

---

## 5. 符号表设计

### 5.1 策略：Name-based + 轻量 Scope 区分 + Proximity Tie-break

不做完整的嵌套作用域树，也不做类型推导（chain lookup 是元数据查询而非真正推导）。在 name-based 索引的基础上：

1. **文件级 scope（含函数参数 / 局部变量）**：每个函数收集参数和函数体内所有声明，不再下钻到 block 级；同函数内多个同名声明（如不同 for-loop 的 `i`、不同 block 的 `temp`）通过 **proximity tie-break** 消歧——按"最近的、行号 ≤ 引用行号的声明"返回。
2. **同名符号多候选**：所有 `#ifdef` 分支、多 Pass 同名、HLSL native overload 等情况一律全部收入索引，F12 时返回多候选由 VSCode Peek UI 让用户挑（见 ADR-0001）。
3. **declaration macro 识别**：通过宏声明的符号（`TEXTURE2D(_MainTex)` 等）由 Macro Pattern Recognizer 识别后登记为变量（见 ADR-0003）。
4. **struct 成员链式查找（chain lookup）**：通过变量声明的类型找到对应 struct，再在 struct 内查成员；MVP 数据结构支持到 L3（参数、局部声明、带初始化的声明、函数返回值），实际跳转能力在 P1 实现。

### 5.2 符号类型与索引方式

| 符号类型 | 索引 key | 跳转逻辑 |
|---|---|---|
| 全局函数 | `functionName` | 全局查找，多候选返回 |
| 全局变量 / cbuffer 成员 | `variableName` | 全局查找，多候选返回 |
| 通过 declaration macro 声明的变量 | `variableName` | Macro Pattern Recognizer 提取后等同全局变量 |
| struct 定义 | `structName` | 全局查找 |
| struct 成员 | `structName.memberName` | chain lookup 推断变量类型 → 在对应 struct 内查 |
| 函数参数 | `functionName::paramName` | 函数 scope 内查；找不到才查全局 |
| 局部变量 | `functionName::variableName` | 函数 scope 内查（含 proximity tie-break）；找不到才查全局 |
| 宏 (`#define`) | `macroName` | 全局查找 |
| `#pragma vertex/fragment/kernel/...` 入口 | Reference pattern 解析后等同函数引用 | 查全局函数索引 |
| `#include` 路径 | 路径字符串 | 经 Include Resolver 解析为绝对路径后打开 |

### 5.3 符号数据结构

```typescript
type SymbolKind =
  | 'function'
  | 'variable'
  | 'parameter'
  | 'localVariable'
  | 'struct'
  | 'structMember'
  | 'macro'
  | 'cbuffer';

interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  location: {
    uri: string;
    range: Range;
  };
  scope?: string;          // 所属函数名（参数 / 局部变量时有值）
  parentType?: string;     // 所属 struct 名（struct 成员时有值）
  scopeRange?: Range;      // 该符号可见的文本范围；全局符号 = 整个文件，参数 / 局部变量 = 函数体
  declaredType?: string;   // 声明的类型名（variable / parameter / localVariable / structMember 时有值，用于 chain lookup）
}

interface FunctionSymbolEntry extends SymbolEntry {
  kind: 'function';
  returnType: string;      // chain lookup L3 所需
  parameters: Array<{
    name: string;
    type: string;
    range: Range;
  }>;
}

interface ReferenceEntry {
  name: string;
  location: { uri: string; range: Range };
  context: 'call' | 'type' | 'member' | 'pragma' | 'identifier';
}

// 正向符号索引（多候选 → 数组）
type SymbolIndex = Map<string, SymbolEntry[]>;

// 反向引用索引（per-file 权威 + lazy 全局 map）
interface FileIndex {
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
}
type ReferenceIndex = Map<string, ReferenceEntry[]>;  // lazy 构建
```

`declaredType` / `returnType` / `parameters` 字段虽然 MVP 不直接使用 chain lookup，但符号收集阶段已能从 tree-sitter 节点天然提取，MVP 阶段顺手填上以避免 P1 时重新 parse。

---

## 6. Include 路径解析

### 6.1 搜索优先级（从高到低）

1. **当前文件所在目录**（处理相对路径 `#include "MyUtils.hlsl"`）
2. **projectRoot/Assets/**
3. **Packages 物理路径**（由 PackageResolver 从 `Packages/packages-lock.json` 解析得到，见 ADR-0002）
4. **用户配置的 `includeDirectories`**（如魔改 Unity 的 CGIncludes 路径）

### 6.2 Packages 路径解析逻辑

```
输入: #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

1. 提取 package name: "com.unity.render-pipelines.universal"
2. 查询 PackageResolver:
   - PackageResolver 启动时读 Packages/packages-lock.json
   - lock 文件直接给出每个包的物理路径，覆盖 embedded / local (file:) / registry / git 全部四种来源
3. 拼接物理路径 + 后续路径: {physical_path}/ShaderLibrary/Core.hlsl
```

老版本 Unity（< 2019.3）无 `packages-lock.json`——这些项目落入 standalone 模式或要求用户手动配置 `includeDirectories`。

### 6.3 边角情况

- **环形 include**：parse 阶段维护 visited set（基于绝对路径去重），第二次遇到同一文件直接跳过。
- **Include guard (`#ifndef X_INCLUDED / #define X_INCLUDED / #endif`)**：因为我们不评估 `#ifdef`（见 ADR-0001），整个文件的内容会被照常索引——这是有意行为，不是 bug。
- **大小写**：路径查找默认大小写敏感（Linux/Mac 行为）；找不到时 fallback 到不敏感匹配，**找到后在 log 中输出 warning**，提示用户该 include 在大小写敏感平台会失败。

### 6.4 `#include` 语法支持

```hlsl
#include "relative/path.hlsl"              // 双引号，相对路径
#include "Packages/com.xxx/path.hlsl"      // 双引号，Packages 虚拟路径
#include "Absolute/Path/From/Include.hlsl" // 双引号，从 includeDirectories 查找
```

---

## 7. ShaderLab 解析策略

### 7.1 设计原则

ShaderLab 外层不需要完整语义分析，只需要：
1. 正确识别 HLSL 代码块的起止边界
2. 提取 Document Symbols 所需的结构信息

### 7.2 代码块边界识别

使用行级状态机：

```
状态: SHADERLAB | HLSL_BLOCK

触发规则:
  SHADERLAB → HLSL_BLOCK: 遇到行 "HLSLPROGRAM" / "CGPROGRAM" / "HLSLINCLUDE" / "CGINCLUDE"
  HLSL_BLOCK → SHADERLAB: 遇到行 "ENDHLSL" / "ENDCG"
```

HLSL_BLOCK 内的内容交给 tree-sitter-hlsl 解析。

### 7.3 多 Pass 与 HLSLINCLUDE

`.shader` 文件可能有多个 HLSL 块（HLSLINCLUDE + 多个 Pass 的 HLSLPROGRAM）。**整个 `.shader` 文件视为扁平 scope**——所有 HLSL 块的符号都进同一个文件级符号表，HLSLINCLUDE 自动对所有 Pass 可见。同名符号（多 Pass 各有 `vert`）走多候选 Peek（见 ADR-0001）。

### 7.4 Document Symbols 提取

从 ShaderLab 层提取：
- `Shader "Name"` → 顶层 symbol
- `SubShader` → 子级
- `Pass { Name "xxx" }` → 子级
- Pass 内的 `#pragma vertex/fragment/kernel/...` → entry-point 节点

从 HLSL 块内提取：
- 函数定义
- struct / cbuffer 定义

---

## 8. 索引生命周期

### 8.1 索引时机

| 事件 | 行为 |
|---|---|
| 扩展激活 | 检测 Unity project root（向下递归找含 `Assets/ + ProjectSettings/` 的目录）；命中则后台异步全量扫描，未命中进入 standalone 模式 |
| 启动时存在缓存 | 读 `Library/UnityShaderNavCache/`，按 `(filepath, mtime, size)` 校验后增量加载，只重 parse 失效的文件 |
| 文件保存 | 增量重新 parse 该文件，更新符号表 + references |
| 打开的 buffer 编辑（didChange） | 实时 in-memory parse，覆盖磁盘版索引数据；未打开的文件按磁盘版 |
| 文件新增/删除 | File watcher 触发，进入 debounce 窗口 |
| `.git/HEAD` 变化 | 直接走 rebuild 模式（分支切换） |
| `Packages/manifest.json` / `Packages/packages-lock.json` 变化 | 直接走 rebuild 模式（包依赖变更） |
| 单个 debounce 窗口（500ms）内变更 ≥ 20 文件 | 切换到 rebuild 模式（清空索引→后台全量 rescan） |
| Rebuild 期间收到 LSP 请求 | 请求挂起最多 5s + 进度条；超时返回当前已索引到的部分结果 |

### 8.2 索引范围

- **用户文件**：workspace 下所有 `.shader/.hlsl/.cginc/.hlslinc/.compute`，按 `unityShaderNav.excludePatterns` 过滤
- **Packages**：PackageResolver 从 `packages-lock.json` 解析的所有包（不扫 `Library/PackageCache/` 下未被引用的旧版本残留），**不受 `excludePatterns` 控制**
- **用户配置的 `includeDirectories`**

### 8.3 性能预期

| 指标 | 数值 |
|---|---|
| 索引单个文件 | ~10-50ms（tree-sitter 增量解析） |
| 典型 URP 项目全量索引（1000+ 文件） | 首次冷启动 10-30s；冷启动后命中缓存 < 2s |
| 典型 HDRP 项目（2000+ 文件） | 首次冷启动 20-60s；冷启动后命中缓存 < 4s |
| 增量更新（单文件保存） | < 100ms |
| 跳转响应时间（索引就绪后） | < 50ms |
| 冷启动期间跳转响应 | 挂起 + 进度条，最长 5s 超时降级 |

### 8.4 多 root workspace

每个 workspace folder 独立检测 Unity project root，**独立维护索引和符号表，跨 root 强隔离**（与 Unity 自身"shader 不跨项目共享"的语义一致）。

### 8.5 Standalone 模式

未检测到 Unity project root 时进入。同文件内符号导航（函数 / struct / 局部变量 / 参数）仍可用；跨文件跳转和 #include 解析禁用。状态栏显示 `UnityShaderNav: standalone mode`。缓存降级到 VSCode `globalStorageUri`。

---

## 9. 配置项

在 VSCode `settings.json` 中配置，前缀 `unityShaderNav`：

```jsonc
{
  // Unity 项目根目录（含 Assets/ 和 Packages/）
  // 默认空字符串 → 自动检测；用户可显式覆盖
  "unityShaderNav.projectRoot": "",

  // 额外的 include 搜索路径（如魔改 Unity 的 CGIncludes）
  "unityShaderNav.includeDirectories": [
    "/path/to/custom-editor/Data/CGIncludes"
  ],

  // 不索引的路径 glob（仅作用于 workspace 用户目录，不影响 Packages 索引）
  "unityShaderNav.excludePatterns": [
    "**/Library/**",
    "**/Temp/**",
    "**/Logs/**"
  ],

  // 用户追加的 declaration macro 白名单（与内置表合并）
  // 格式: { pattern: "MY_TEX2D($name)", kind: "variable" }
  "unityShaderNav.declarationMacros": [],

  // Find References 是否包含 Packages 下的引用
  "unityShaderNav.findReferences.includePackages": false
}
```

---

## 10. 验收标准

### MVP 达标（必须全部通过）

| # | Case | 预期结果 |
|---|---|---|
| 1 | 在 .shader 的 HLSLPROGRAM 块内，F12 在同文件定义的函数上 | 跳到该函数声明处 |
| 2 | F12 在同目录另一个 .hlsl 文件中定义的函数上 | 跳到该文件中的函数定义 |
| 3 | F12 在 `TransformObjectToHClip` 上 | 跳到 URP Package 中 SpaceTransforms.hlsl 的定义处（可能多候选） |
| 4 | F12 在 `#include "xxx.hlsl"` 的路径字符串上 | 直接打开目标文件 |
| 5 | F12 在 `TEXTURE2D(_MainTex)` 后某个使用点的 `_MainTex` 上 | 跳到 `TEXTURE2D(_MainTex)` 声明处（declaration macro 白名单） |
| 6 | F12 在 `#pragma vertex vert` 的 `vert` 上 | 跳到 `vert` 函数定义（reference pattern） |
| 7 | F12 在 .compute 文件的 `#pragma kernel CSMain` 的 `CSMain` 上 | 跳到 CSMain 函数 |
| 8 | F12 在函数参数 identifier 上 | 跳到所属函数的参数列表 |
| 9 | multi-root workspace，项目 A 的文件 F12 | 仅在项目 A 范围内查找，不跨 root |

### MVP+ 加分项

| # | Case | 预期结果 |
|---|---|---|
| 10 | F12 在 struct 成员 `.positionWS` 上 | 跳到 struct 定义中该字段（chain lookup L1-L3） |
| 11 | F12 在 `SAMPLE_TEXTURE2D(...)` 宏调用上 | 跳到 `#define SAMPLE_TEXTURE2D` 处 |
| 12 | Ctrl+Shift+O | 显示当前文件的函数/struct/cbuffer/pragma 入口大纲 |
| 13 | Shift+F12 在用户文件的函数上 | 列出 user files 范围内所有引用 |
| 14 | Shift+F12 并配置 `findReferences.includePackages: true` | 列表新增 Packages 下的引用 |

---

## 11. 约束与风险

| 风险 | 级别 | 应对 |
|---|---|---|
| tree-sitter-hlsl 不识别部分 Unity 特有 pragma | 低 | pragma 不参与符号解析（reference pattern 仅识别我们关心的入口 pragma），不影响跳转 |
| 通过未知 declaration macro 声明的变量找不到 | 中 | 用户在 `declarationMacros` 配置追加；文档说明 |
| 宏展开后的符号定位不准 | 中 | MVP 不展开宏体内容，只跳到 `#define` 行（ADR-0003）。P2 可加部分宏展开 |
| 同名符号跳错（多个 #ifdef 分支 / 多 Pass 同名 / overload） | 设计本意 | 多候选 Peek，用户选择（ADR-0001）；P2 可加 Shader Context Picker |
| CG 语法兼容性有限 | 中 | built-in RP 老项目部分降级；Surface Shader 隐式参数不支持，文档说明 |
| 大型 monorepo / HDRP 首次冷启动慢 | 中 | 进度条 + 5s 请求挂起 + 索引持久化到 `Library/`，二次启动命中缓存 |
| Bulk 文件变更（git checkout 切大分支）期间索引不一致 | 中 | 监听 `.git/HEAD` + debounce 阈值，切换 rebuild 模式（ADR-0007 待定，目前在 spec §8.1） |
| 老版本 Unity（< 2019.3）无 `packages-lock.json` | 低 | 落入 standalone 模式或要求用户配置 `includeDirectories` |
| Windows 路径大小写不一致导致跨平台 bug | 低 | 大小写敏感优先 + fallback warning，提示用户潜在跨平台问题 |
| 魔改 Unity Editor 的 CGIncludes 路径不标准 | 低 | 通过 `includeDirectories` 配置手动指定 |

---

## 12. 技术栈与依赖

```json
{
  "dependencies": {
    "vscode-languageclient": "^9.x",
    "vscode-languageserver": "^9.x",
    "vscode-languageserver-textdocument": "^1.x",
    "web-tree-sitter": "^0.22.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@vscode/vsce": "^2.x"
  }
}
```

tree-sitter-hlsl 需编译为 WASM 文件随扩展分发。

---

## 13. 后续演进方向

按需迭代，不在 MVP 范围内：

1. **Shader Context Picker (P2)** → 分析 multi_compile 集合，在多候选中指定默认活跃分支
2. **Properties ↔ HLSL 双向跳转 (P2)** → name-based 字符串匹配
3. **Hover 信息 (P2)** → 展示函数签名和参数
4. **struct chain lookup L4** → 数组元素 / 嵌套字段 / cbuffer 内 struct
5. **部分宏展开** → 处理简单的 token-level 宏，扩大 declaration macro 识别范围
6. **Workspace Symbol Search** → Ctrl+T 全局符号搜索
7. **发布到 VSCode Marketplace** → 补充 README、CI/CD、兼容性测试
