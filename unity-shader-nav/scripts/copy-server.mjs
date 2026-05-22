// Copy the tsc-built server output tree into client/out/server so a packaged
// VSIX rooted at client/ can find the LSP entry via
// context.asAbsolutePath('out/server/server.js'). Mirrors the layout that
// scripts/build.mjs (esbuild) produces.
import { cp, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(monorepoRoot, 'server/out');
const to = resolve(monorepoRoot, 'client/out/server');

try { await access(resolve(from, 'server.js')); }
catch { throw new Error(`copy-server: missing ${from}/server.js — did the server workspace build first?`); }

await cp(from, to, { recursive: true, force: true });
console.log(`[copy-server] ${from} -> ${to}`);
