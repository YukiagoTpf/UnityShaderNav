import { cp } from 'node:fs/promises';
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  format: 'cjs',
};

await build({ ...common, entryPoints: ['client/src/extension.ts'], outfile: 'client/out/extension.js' });
await build({ ...common, entryPoints: ['server/src/server.ts'],    outfile: 'client/out/server/server.js' });
await cp('server/grammars', 'client/out/grammars', { recursive: true, force: true });

console.log('bundle done');
