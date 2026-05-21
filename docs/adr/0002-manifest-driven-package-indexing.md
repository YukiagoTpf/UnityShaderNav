# Manifest-driven Package Indexing

## Context

Unity 项目的 shader include 大量来自 Packages（URP/HDRP/Core RP/ShaderGraph 等），物理上散落在 `Packages/`（embedded/local）和 `Library/PackageCache/`（registry/git）。spec 草稿同时存在两个矛盾：
1. §8.2 要求"扫描 Packages 路径"——隐含全量扫 `Library/PackageCache/`
2. §9 的 `excludePatterns` 默认 `**/Library/**`——会把 PackageCache 整个排除

且全量扫 PackageCache 还会包含**项目未引用**的旧版本包目录残留，浪费索引时间。

## Decision

以 `Packages/packages-lock.json` 为 ground truth 解析项目实际依赖的包路径，**只索引这些包**。`Library/` 默认 exclude 规则保持，PackageCache 走独立的"白名单"路径列表（由 PackageResolver 在启动时根据 lock 文件解析得到）。

`excludePatterns` 仅作用于 workspace 用户目录，不应被用来描述 Packages 的索引边界。

## Why packages-lock.json instead of manifest.json

`manifest.json` 只声明用户的依赖意图（含版本范围、git URL、file: 协议路径），需要扩展自己模拟 Unity 的解析逻辑才能得到物理路径。`packages-lock.json` 是 Unity 解析完依赖图后落盘的快照，**直接给出每个包的物理路径**，省去重新实现解析器，且与 Unity 自身行为零偏差。

## Consequences

- 必须监听 `Packages/packages-lock.json` 变化触发 rebuild（见 ADR-0007 / spec §8）。
- 用户若手动操作 `Library/PackageCache/`（罕见），索引可能与 Unity 实际状态偏离——可接受。
- 老版本 Unity（< 2019.3）没有 lock 文件——这些项目落入降级模式，目前不在 MVP 支持范围。
