# UnityShaderNav

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

UnityShaderNav 是一个用于 Unity Shader 项目的 Visual Studio Code 扩展。它能理解 ShaderLab 外层结构、HLSL/CG include 文件、Unity Packages、声明宏，以及 URP/HDRP 项目里常见的同名符号和多候选跳转场景。

这个扩展专注于快速代码导航：

- 为函数、局部变量、参数、struct、struct 成员、宏、`#include` 路径和 shader 入口函数提供 Go to Definition。
- 在已索引的用户文件中查找引用，并可选择是否包含 package 引用。
- 为已索引的 HLSL/CG 代码提供保守的补全和签名帮助，并包含精选的 Unity/HLSL/ShaderLab 内置词汇。
- 为 ShaderLab 外层结构、Properties、Tags、render states、预处理行和
  HLSL 符号提供 Document Symbols 与语义着色。
- 保守地变暗不生效和 variant 门控的 `#if`/`#ifdef` 预处理分支（仅影响呈现，不改变导航）。
- 通过 `Packages/packages-lock.json` 解析 Unity Package。
- 在 `Library/UnityShaderNavCache/` 下持久化项目本地索引缓存。

## 状态

项目目前处于早期 public preview 阶段。核心 language server 已经可以工作，并有单元测试和 VS Code 集成测试覆盖；Marketplace 发布、release 自动化、CI 缓存优化，以及少数 Unity 路径边界情况仍在 [GitHub Issues](https://github.com/YukiagoTpf/UnityShaderNav/issues) 中跟踪。

## 支持的文件

UnityShaderNav 会在这些文件中激活：

- `.shader`
- `.hlsl`
- `.cginc`
- `.hlslinc`
- `.compute`

独立 HLSL 文件可以使用同文件导航。完整跨文件导航需要 Unity project root 中同时包含 `Assets/` 和 `ProjectSettings/`。

## 安装

### 方法一：从 Releases 下载 VSIX

1. 打开 [latest release](https://github.com/YukiagoTpf/UnityShaderNav/releases/latest)。
2. 在 release assets 中下载 `unity-shader-nav-*.vsix`。
3. 在 VS Code 中打开 Extensions 视图。
4. 点击 `...` -> `Install from VSIX...`。
5. 选择刚下载的 VSIX 文件。

安装后，打开一个 Unity 项目，然后打开 `.shader`、`.hlsl`、`.cginc`、`.hlslinc` 或 `.compute` 文件即可使用。

### 方法二：从源码构建

如果你想开发扩展，或本地打包一个 VSIX，请使用这种方式。

要求：

- VS Code 1.85 或更新版本
- Node.js 18 或更新版本
- npm

```powershell
cd unity-shader-nav
npm install
npm run build
```

从源码运行扩展：

1. 用 VS Code 打开 `unity-shader-nav/`。
2. 在终端运行 `npm run watch`，等待出现 `[watch-runtime] build ok`。
3. 按 F5，并选择扩展启动配置。
4. 在 Extension Development Host 中打开 Unity 项目。
5. 打开 `.shader`、`.hlsl`、`.cginc`、`.hlslinc` 或 `.compute` 文件。
6. 修改源码后，等待下一次 `[watch-runtime] build ok`，然后重新加载 Extension Development Host 窗口。

本地打包 VSIX：

```powershell
cd unity-shader-nav
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
- [Roadmap](docs/roadmap.md)
- [Technical Spec](docs/technical-spec.md)
- [Architecture Decision Records](docs/adr/)

## 已知限制

- 不求值预处理条件；多个有效定义会通过 VS Code Peek Definition 一并返回。
- 不展开宏体。内置和用户配置的 declaration patterns 会覆盖常见 Unity 宏声明。
- 不把 Surface Shader 隐式参数和 ShaderGraph 生成代码作为特殊来源索引。
- 内置补全和签名帮助是精选词表，不保证穷尽；当项目符号与内置名称冲突时，优先使用项目符号。
- Chain lookup 对跨行 receiver、宏展开 receiver、分支相关类型、overload-specific return type inference 等情况保持保守。

## 贡献

欢迎提交 bug、最小复现和小型 PR。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，再查看当前 [issue tracker](https://github.com/YukiagoTpf/UnityShaderNav/issues)。

## 许可证

UnityShaderNav 使用 [MIT License](LICENSE) 发布。
