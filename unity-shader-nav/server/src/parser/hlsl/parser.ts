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

async function ensureReady(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      TS = requireCjs('web-tree-sitter');
      await TS.init();
      // From server/{src,out}/parser/hlsl/parser → ../../../grammars/tree-sitter-hlsl.wasm
      const wasm = join(__dirname, '..', '..', '..', 'grammars', 'tree-sitter-hlsl.wasm');
      language = await TS.Language.load(wasm);
    })();
  }
  await initPromise;
}

export async function parseHlsl(text: string): Promise<Parser.Tree> {
  await ensureReady();
  const parser = new TS();
  parser.setLanguage(language!);
  return parser.parse(text);
}

export async function getLanguage(): Promise<Parser.Language> {
  await ensureReady();
  return language!;
}
