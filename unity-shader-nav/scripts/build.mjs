import { cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  outfile: resolve(monorepoRoot, 'client/out/server/server.js'),
});
await cp(
  resolve(monorepoRoot, 'server/grammars'),
  resolve(monorepoRoot, 'client/out/grammars'),
  { recursive: true, force: true },
);

console.log('bundle done');
