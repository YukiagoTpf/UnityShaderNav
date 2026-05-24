import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type Parser from 'web-tree-sitter';

// web-tree-sitter 0.22 mutates module.exports during init(); the captured
// ESM default import keeps a stale binding under vite/vitest. Re-resolve via
// createRequire after init so post-init properties (Language, etc.) are
// visible on the same object reference.
const requireCjs = createRequire(__filename);

let initPromise: Promise<void> | undefined;
let language: Parser.Language | undefined;
let TS: any;

const HLSL_WASM = 'tree-sitter-hlsl.wasm';
const STRUCT_FIELD_MACRO_LINE_RE = /^([ \t]*)(UNITY_VERTEX_INPUT_INSTANCE_ID|UNITY_VERTEX_OUTPUT_STEREO)([ \t]*)$/gm;

function resolveWasmPath(): string {
  const candidates = [
    // server/{src,out}/parser/hlsl and client/out/server/parser/hlsl after copy-server.
    join(__dirname, '..', '..', '..', 'grammars', HLSL_WASM),
    // client/out/server/server.js when scripts/build.mjs bundles the server.
    join(__dirname, '..', 'grammars', HLSL_WASM),
  ];
  const wasm = candidates.find((candidate) => existsSync(candidate));
  if (!wasm) {
    throw new Error(`Unable to find ${HLSL_WASM}. Tried: ${candidates.join(', ')}`);
  }
  return wasm;
}

async function ensureReady(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      TS = requireCjs('web-tree-sitter');
      await TS.init();
      language = await TS.Language.load(resolveWasmPath());
    })();
  }
  await initPromise;
}

export async function parseHlsl(text: string): Promise<Parser.Tree> {
  await ensureReady();
  const parser = new TS();
  parser.setLanguage(language!);
  return parser.parse(stabilizeMacroStatementLines(text));
}

export async function getLanguage(): Promise<Parser.Language> {
  await ensureReady();
  return language!;
}

function stabilizeMacroStatementLines(text: string): string {
  return text.replace(STRUCT_FIELD_MACRO_LINE_RE, (_line, indent: string, name: string, trailing: string) =>
    `${indent}${name.slice(0, -1)};${trailing}`);
}
