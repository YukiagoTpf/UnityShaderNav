import { createRequire } from 'node:module';
import type Parser from 'web-tree-sitter';
import {
  loadHlslGrammar,
  resolveRunningParserRuntimeAssets,
  type ParserRuntimeAssets,
} from '../runtimeAssets';

// web-tree-sitter 0.22 mutates module.exports during init(); the captured
// ESM default import keeps a stale binding under vite/vitest. Re-resolve via
// createRequire after init so post-init properties (Language, etc.) are
// visible on the same object reference.
const requireCjs = createRequire(__filename);

let initPromise: Promise<void> | undefined;
let language: Parser.Language | undefined;
let readyAssets: ParserRuntimeAssets | undefined;
let TS: any;

const STRUCT_FIELD_MACRO_LINE_RE = /^([ \t]*)(UNITY_VERTEX_INPUT_INSTANCE_ID|UNITY_VERTEX_OUTPUT_STEREO)([ \t]*)$/gm;

async function ensureReady(): Promise<ParserRuntimeAssets> {
  if (!initPromise) {
    const assets = resolveRunningParserRuntimeAssets();
    initPromise = (async () => {
      TS = requireCjs('web-tree-sitter');
      await TS.init();
      language = await loadHlslGrammar(
        assets,
        (bytes) => TS.Language.load(bytes),
      );
      readyAssets = assets;
    })();
  }
  const attempt = initPromise;
  try {
    await attempt;
  } catch (error) {
    if (initPromise === attempt) {
      initPromise = undefined;
      language = undefined;
      readyAssets = undefined;
      TS = undefined;
    }
    throw error;
  }
  return readyAssets!;
}

export async function ensureParserReady(): Promise<ParserRuntimeAssets> {
  return ensureReady();
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
