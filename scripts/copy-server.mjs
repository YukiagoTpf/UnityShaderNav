// Materialize the copied-server layout through the authoritative runtime graph.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import runtimeArtifacts from './runtime-artifacts.cjs';

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const graph = runtimeArtifacts.createRuntimeArtifactGraph(monorepoRoot);

await runtimeArtifacts.assembleCopiedServerRuntime(graph);
console.log('[copy-server] assembled copied server runtime');
