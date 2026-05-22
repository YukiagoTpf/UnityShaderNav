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
const grammarsFrom = resolve(monorepoRoot, 'server/grammars');
const grammarsTo = resolve(monorepoRoot, 'client/out/grammars');

try { await access(resolve(from, 'server.js')); }
catch { throw new Error(`copy-server: missing ${from}/server.js — did the server workspace build first?`); }
try { await access(resolve(grammarsFrom, 'tree-sitter-hlsl.wasm')); }
catch { throw new Error(`copy-server: missing ${grammarsFrom}/tree-sitter-hlsl.wasm`); }

await cp(from, to, { recursive: true, force: true });
await cp(grammarsFrom, grammarsTo, { recursive: true, force: true });
console.log(`[copy-server] ${from} -> ${to}`);
console.log(`[copy-server] ${grammarsFrom} -> ${grammarsTo}`);
