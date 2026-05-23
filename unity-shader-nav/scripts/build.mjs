import { access, cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverOut = resolve(monorepoRoot, 'client/out/server');
const treeSitterRuntimeFrom = resolve(monorepoRoot, 'node_modules/web-tree-sitter');
const treeSitterRuntimeTo = resolve(serverOut, 'node_modules/web-tree-sitter');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  format: 'cjs',
};

await build({
  ...common,
  entryPoints: [resolve(monorepoRoot, 'client/src/extension.ts')],
  outfile: resolve(monorepoRoot, 'client/out/extension.js'),
});
await build({
  ...common,
  entryPoints: [resolve(monorepoRoot, 'server/src/server.ts')],
  outfile: resolve(serverOut, 'server.js'),
});
await cp(
  resolve(monorepoRoot, 'server/grammars'),
  resolve(monorepoRoot, 'client/out/grammars'),
  { recursive: true, force: true },
);
try { await access(resolve(treeSitterRuntimeFrom, 'tree-sitter.js')); }
catch { throw new Error(`build: missing ${treeSitterRuntimeFrom}/tree-sitter.js - did npm install run?`); }
try { await access(resolve(treeSitterRuntimeFrom, 'tree-sitter.wasm')); }
catch { throw new Error(`build: missing ${treeSitterRuntimeFrom}/tree-sitter.wasm - did npm install run?`); }
await rm(treeSitterRuntimeTo, { recursive: true, force: true });
await cp(treeSitterRuntimeFrom, treeSitterRuntimeTo, { recursive: true, force: true });

console.log('bundle done');
