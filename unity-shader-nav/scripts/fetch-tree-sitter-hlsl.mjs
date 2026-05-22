// 用法：node scripts/fetch-tree-sitter-hlsl.mjs
//
// 从 tree-sitter-grammars/tree-sitter-hlsl release 拉 WASM。
// 截至 v0.2.0 上游 release 没有 .wasm artifact (仅 native prebuilds)，
// 所以此 fetch 会 404。该脚本保留作为"未来上游若发布 wasm 时"的快路径。
//
// 当前生产路径（实际入库 server/grammars/tree-sitter-hlsl.wasm 的方式）：
//   1. git clone --depth=1 https://github.com/tree-sitter-grammars/tree-sitter-hlsl /tmp/tree-sitter-hlsl
//   2. cd /tmp/tree-sitter-hlsl && npm install --no-save tree-sitter-cli@^0.24
//   3. 确保 Docker Desktop 已启动 (tree-sitter CLI 用 emscripten/emsdk 容器编译 wasm)
//   4. node_modules/.bin/tree-sitter build --wasm
//   5. cp tree-sitter-hlsl.wasm <repo>/server/grammars/
//
// 这一步在 Plan 03 实施时手工跑过一次，wasm 入库后无需重跑。
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const URL = 'https://github.com/tree-sitter-grammars/tree-sitter-hlsl/releases/latest/download/tree-sitter-hlsl.wasm';

const res = await fetch(URL, { redirect: 'follow' });
if (!res.ok) {
  console.error(`fetch failed ${res.status}; upstream release likely has no wasm artifact.`);
  console.error('Fallback: see header comment in this script for the docker-based build path.');
  process.exit(1);
}
await mkdir('server/grammars', { recursive: true });
writeFileSync('server/grammars/tree-sitter-hlsl.wasm', Buffer.from(await res.arrayBuffer()));
console.log('downloaded tree-sitter-hlsl.wasm');
