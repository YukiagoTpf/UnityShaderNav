import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import runtimeArtifacts from './runtime-artifacts.cjs';

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const graph = runtimeArtifacts.createRuntimeArtifactGraph(monorepoRoot);
const extensionBundle = graph.bundles.find((bundle) => bundle.id === 'extension');
const serverBundle = graph.bundles.find((bundle) => bundle.id === 'server');
if (!extensionBundle || !serverBundle) throw new Error('runtime artifact graph is missing bundles');

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
  entryPoints: [resolve(monorepoRoot, extensionBundle.entry)],
  outfile: resolve(monorepoRoot, extensionBundle.output),
});
await runtimeArtifacts.assembleCopiedServerRuntime(graph);
await build({
  ...common,
  entryPoints: [resolve(monorepoRoot, serverBundle.entry)],
  outfile: resolve(monorepoRoot, serverBundle.output),
});
await runtimeArtifacts.writeRuntimeArtifactManifest(graph);

console.log('[runtime-artifacts] bundle and runtime assembly complete');
