# UnityShaderNav

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

UnityShaderNav 是一个用于 Unity Shader 项目的 Visual Studio Code 扩展。它能理解 ShaderLab 外层结构、HLSL/CG include 文件、Unity Packages、声明宏，以及 URP/HDRP 项目里常见的同名符号和多候选跳转场景。

这个扩展专注于快速代码导航：

- 为函数、局部变量、参数、struct、struct 成员、宏、`#include` 路径和 shader 入口函数提供 Go to Definition。
- 在已索引的用户文件中查找引用，并可选择是否包含 package 引用。
- 通过 Unity Editor Adapter 连接 File 模式的 Shader Graph Custom Function
  节点与 HLSL：F12 跳到带精度后缀的声明，Find References 回到 graph 节点，
  Problems 聚焦报告 include 缺失、后缀无效和 port/signature 不匹配。
- 通过 Adapter 将 ShaderLab Property 引用连接到源码仍然新鲜的 C# 调用，支持常量
  `Shader.PropertyToID` 流程和带类型的 `Material` /
  `MaterialPropertyBlock` Set/Get accessor。Problems 报告已证明的类型不匹配；
  仅名称或动态证据明确标为不确定，且不会注册与现有 C# 扩展竞争的语言 provider。
- 为 ShaderLab 的 `Shader`、`Fallback`、Pass `Name` 与 `UsePass` 提供跨项目的定义、引用、悬浮、补全、Workspace 符号和保守重命名；`UsePass` 的 Pass 段遵循 Unity 的大写规范形式。
- 为声明身份唯一的 HLSL/CG 符号及同一 `.shader` 文件内的 ShaderLab Property 契约提供保守的 Workspace Rename，并在重载、预处理或 Package 等不安全场景拒绝修改。
- 在 VS Code Problems 中报告无法解析的 vertex、fragment、geometry、hull、domain、surface 与 compute kernel 入口，并随实时文档和项目索引更新。
- 保守检查 SRP Batcher 材质契约：标出未进入 `UnityPerMaterial` 的标量/向量 Property、不兼容字段类型及可确定的跨 Pass 布局差异；只有唯一且安全的插入位置才提供 Quick Fix。
- 悬浮（Hover）显示已索引着色器符号（函数、struct、字段、变量、参数、宏）的声明摘要，并为部分 ShaderLab 术语、Property 语法、语义和 SRP helper 提供带公开来源的 Quick Documentation。Unity 项目中的 `UNITY_VERSION` 还会显示从 `ProjectSettings/ProjectVersion.txt` 派生的纯展示值；项目和 Package 中的真实声明仍优先于这些版本感知兜底。
- 为已索引的 HLSL/CG 代码提供保守的补全和签名帮助，并包含精选的 Unity/HLSL/ShaderLab 内置词汇。
- 提供仅在正确上下文出现的完整 Surface 与 vertex/fragment Shader、常用 Material Property、Pass/program 结构及 Blend 状态 snippets；可编辑归一化的 Color 默认字面量；并安全格式化 ShaderLab 缩进。
- 为 ShaderLab 外层结构、Properties、Tags、render states、预处理行和
  HLSL 符号提供 Document Symbols 与语义着色。
- 跨文件的 Workspace 符号搜索（Ctrl+T / Cmd+T），覆盖已索引的 shader 函数、
  struct、struct 成员、cbuffer、宏和全局变量。默认排除 package 内符号，
  遵循 `findReferences.includePackages` 设置。
- 保守地变暗不生效和 variant 门控的 `#if`/`#ifdef` 预处理分支（仅影响呈现，不改变导航）。
- 可选的变体上下文选择器（状态栏 + QuickPick），用于消解 `multi_compile` / `shader_feature` 歧义：激活的分支变亮，未激活的分支变暗，当上下文使目标唯一时 F12 直接跳转到激活变体。需手动启用；默认行为不变。
- 通过 `Packages/packages-lock.json` 解析 Unity Package。
- 在 `Library/UnityShaderNavCache/` 下持久化项目本地索引缓存。

## 状态

项目目前处于 public preview 阶段。可以从
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Yukiago.unity-shader-nav)
安装最新版本，也可以从
[GitHub Releases](https://github.com/YukiagoTpf/UnityShaderNav/releases)
下载构建和查看发布说明。当前工作见
[GitHub Issues](https://github.com/YukiagoTpf/UnityShaderNav/issues)。

## 支持的文件

UnityShaderNav 会在这些文件中激活：

- `.shader`
- `.hlsl`
- `.cginc`
- `.hlslinc`
- `.compute`
- `.shadergraph`（File 模式 Custom Function 导航需要兼容的 Unity Editor
  Adapter）

独立 HLSL 文件可以使用同文件导航。完整跨文件导航需要 Unity project root 中同时包含 `Assets/` 和 `ProjectSettings/`。

## 安装

### 方法一：从 Visual Studio Marketplace 安装

1. 打开 Visual Studio Marketplace 上的 [UnityShaderNav](https://marketplace.visualstudio.com/items?itemName=Yukiago.unity-shader-nav)。
2. 点击 **Install**，让 VS Code 完成安装。

### 方法二：从 Releases 下载 VSIX

1. 打开 [latest release](https://github.com/YukiagoTpf/UnityShaderNav/releases/latest)。
2. 在 release assets 中下载 `unity-shader-nav-*.vsix`。
3. 在 VS Code 中打开 Extensions 视图。
4. 点击 `...` -> `Install from VSIX...`。
5. 选择刚下载的 VSIX 文件。

安装后，打开一个 Unity 项目，然后打开 `.shader`、`.hlsl`、`.cginc`、
`.hlslinc`、`.compute` 或 `.shadergraph` 文件即可使用。

### 方法三：从源码构建

如果你想开发扩展，或本地打包一个 VSIX，请使用这种方式。

要求：

- VS Code 1.85 或更新版本
- Node.js 18 或更新版本
- npm

```powershell
npm ci
npm run build
```

从源码运行扩展：

1. 用 VS Code 打开仓库根目录。
2. 在终端运行 `npm run watch`，等待出现 `[watch-runtime] build ok`。
3. 按 F5，并选择扩展启动配置。
4. 在 Extension Development Host 中打开 Unity 项目。
5. 打开 `.shader`、`.hlsl`、`.cginc`、`.hlslinc`、`.compute` 或
   `.shadergraph` 文件。
6. 修改源码后，等待下一次 `[watch-runtime] build ok`，然后重新加载 Extension Development Host 窗口。

本地打包 VSIX：

```powershell
npm run package:vsix
```

## 配置

常用设置：

```jsonc
{
  "unityShaderNav.projectRoot": "",
  "unityShaderNav.includeDirectories": [],
  "unityShaderNav.excludePatterns": ["**/Library/**", "**/Temp/**", "**/Logs/**"],
  "unityShaderNav.declarationMacros": [],
  "unityShaderNav.findReferences.includePackages": false
}
```

完整说明和示例见 [Configuration](docs/configuration.md)。

## 文档

- [User Guide](docs/usage.md)
- [Configuration](docs/configuration.md)
- [Development Guide](docs/development.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Technical Spec](docs/technical-spec.md)
- [Architecture Decision Records](docs/adr/)

## 已知限制

- 默认不求值预处理条件；多个有效定义会通过 VS Code Peek Definition 一并返回。可选的变体上下文选择器可以为变暗和导航消解已声明的 `multi_compile` / `shader_feature` 关键字，但这是用户驱动的，不构成编译器级别的变体求值。
- 不展开宏体。内置和用户配置的 declaration patterns 会覆盖常见 Unity 宏声明。
- 不把 Surface Shader 隐式参数和 Shader Graph 生成代码作为特殊来源索引。
  File 模式 Custom Function 导航只消费 Unity Editor Adapter 为受支持版本
  提供的逻辑事实；Adapter 或 capability 不可用时不会猜测 `.shadergraph`
  序列化布局，功能保持中性。
- 内置补全和签名帮助是精选词表，不保证穷尽；当项目符号与内置名称冲突时，优先使用项目符号。
- Quick Documentation 是精选内容，不保证穷尽。Package 专属兜底只会用于版本兼容、include 可见的 Unity built-in 或默认 registry Package；Unity 范围文档目前以 Editor 2022.3 验证，其他或未知 Editor 版本仍会显示并附带验证范围提示。scoped registry、fork、本地来源或版本不兼容的 Package 事实保持中性，除非存在已索引的真实声明。
- Color presentation 不处理 HDR、Vector、表达式或越界分量。格式化只修改 ShaderLab 行首缩进，完整保留嵌入 program/include block 的原始字节；结构畸形时拒绝格式化。HLSL 格式化不在范围内。
- Chain lookup 对跨行 receiver、宏展开 receiver、分支相关类型、overload-specific return type inference 等情况保持保守。
- Rename 要求索引中存在唯一声明；ShaderLab Property 修改只覆盖选定 `.shader` 文件，以及至多一个匹配的 HLSL/CG 声明和可证明引用。内建符号、Package 声明、由 include 提供的 Property 契约及存在歧义的 Shader、Pass 或 HLSL 候选都会被拒绝。
- SRP Batcher 检查要求源码中存在明确 SRP 证据，目前只覆盖 `Color`、`Vector`、`Float`、`Range`、旧版 float-backed `Int` 和 `Integer` Property。纹理资源、条件式或宏生成的 cbuffer 布局，以及有歧义的多 block 修改会保持中性或要求手工处理；在能证明逐 SubShader 的渲染管线归属前，多 SubShader 文件保持中性。

## 贡献

欢迎提交 bug、最小复现和小型 PR。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，再查看当前 [issue tracker](https://github.com/YukiagoTpf/UnityShaderNav/issues)。

## 许可证

UnityShaderNav 使用 [MIT License](LICENSE) 发布。
