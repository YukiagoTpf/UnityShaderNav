# Plan03 Fix Report

Date: 2026-05-22

Source review: `docs/superpowers/plans/plan03review.md`

## 修复摘要

- 修复 P1：`collector` 现在会收集普通 `identifier` 引用，且通过声明点集合跳过函数名、参数名、局部变量名、struct/cbuffer 声明名，避免把声明点计为引用。
- 修复 P1：`tree-sitter-hlsl.wasm` 现在会随 `copy-server.mjs` 和 `scripts/build.mjs` 输出到 `client/out/grammars`。`parser.ts` 会同时支持 `server/{src,out}`、`client/out/server/parser/hlsl` 以及 esbuild bundle 的 `client/out/server/server.js` 布局。
- 修复 P2：新增统一 declarator 解包逻辑，支持多 declarator 和 array declarator。`float x, y`、`float3 arr[2]`、`cbuffer C { float _A, _B; }` 都会完整收集；struct array member 记录为 `pos`，不是 `pos[2]`。

## 变更文件

- `unity-shader-nav/server/src/parser/hlsl/collector.ts`
- `unity-shader-nav/server/src/parser/hlsl/parser.ts`
- `unity-shader-nav/server/tests/parser/hlsl/collector.test.ts`
- `unity-shader-nav/tests/client/package-layout.test.ts`
- `unity-shader-nav/scripts/copy-server.mjs`
- `unity-shader-nav/scripts/build.mjs`

## 回归测试

- `collector.test.ts`
  - 普通 identifier 引用：参数 `a`/`b` 和局部变量 `c` 的 use site 被记录为 `context='identifier'`，声明点不计入引用。
  - 多 declarator / array declarator：局部 `x`/`y`/`arr`、struct member `a`/`b`/`pos`、cbuffer variable `_A`/`_B` 都被收集。
- `tests/client/package-layout.test.ts`
  - 从 `client/out/server/parser/hlsl/parser.js` 导入 copied server parser，并执行 `parseHlsl('float f() { return 1; }')`，覆盖 VSIX copied layout 的 wasm 查找。

## 验证命令和结果

从 `unity-shader-nav/` 执行：

```bash
npm run test -w @unity-shader-nav/server -- parser/hlsl/collector.test.ts
```

结果：先红后绿。修复前 4 个新增 case 失败；修复后 `1 passed / 12 tests passed`。

```bash
npm run build -w @unity-shader-nav/server
```

结果：通过。

```bash
npm run build
```

结果：通过；`copy-server` 输出：

```text
[copy-server] ...\server\out -> ...\client\out\server
[copy-server] ...\server\grammars -> ...\client\out\grammars
```

```bash
node -e "const {parseHlsl}=require('./client/out/server/parser/hlsl/parser'); parseHlsl('float f(){return 1;}').then(t=>console.log('ok',t.rootNode.type,t.rootNode.hasError)).catch(e=>{console.error(e && e.message || e); process.exit(1);})"
```

结果：`ok translation_unit false`。

```bash
npm run test -w @unity-shader-nav/server
```

结果：`8 passed / 43 tests passed`。

```bash
npm test
```

结果：通过；extension-host tests `3 passing`，server vitest `8 passed / 43 tests passed`。

```bash
node scripts/build.mjs
Test-Path "client/out/grammars/tree-sitter-hlsl.wasm"
```

结果：`bundle done`，`True`。

## 剩余风险

- `identifier` 引用目前是语法级收集，不做作用域解析或同名遮蔽消歧；这符合 Plan03 collector 的职责边界，后续 definition/reference plans 需要在索引消费层处理绑定。
