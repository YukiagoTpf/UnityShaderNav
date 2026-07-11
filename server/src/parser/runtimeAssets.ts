import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const HLSL_GRAMMAR_NAME = 'tree-sitter-hlsl.wasm';

export type ParserRuntimeLayout =
  | 'source'
  | 'tsc-out'
  | 'copied-server'
  | 'bundled-server';

export interface ResolvedRuntimeAsset {
  readonly logicalName: string;
  readonly path: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readBytes(): Uint8Array;
}

export interface ParserRuntimeAssets {
  readonly layout: ParserRuntimeLayout;
  readonly runtimeRoot: string;
  readonly hlslGrammar: ResolvedRuntimeAsset;
}

export interface ParserRuntimeLocation {
  readonly kind: ParserRuntimeLayout;
  readonly runtimeRoot: string;
  readonly grammarPath: string;
}

export class ParserRuntimeAssetsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ParserRuntimeAssetsError';
  }
}

/**
 * Resolve the grammar from one explicitly supported server layout. The bytes
 * are captured once in the returned fact; consumers never reopen the path.
 */
export function resolveParserRuntimeAssets(moduleFile: string): ParserRuntimeAssets {
  const layout = locateParserRuntimeAssets(moduleFile);
  let grammarPath: string;
  let bytes: Buffer;
  try {
    grammarPath = realpathSync(layout.grammarPath);
    bytes = readFileSync(grammarPath);
  } catch (error) {
    throw new ParserRuntimeAssetsError(
      `Unable to load parser runtime asset ${layout.grammarPath}`,
      { cause: error },
    );
  }

  const snapshot = Buffer.from(bytes);
  const hlslGrammar: ResolvedRuntimeAsset = Object.freeze({
    logicalName: HLSL_GRAMMAR_NAME,
    path: grammarPath,
    byteLength: snapshot.byteLength,
    contentHash: createHash('sha256').update(snapshot).digest('hex'),
    readBytes: (): Uint8Array => Uint8Array.from(snapshot),
  });

  return Object.freeze({
    layout: layout.kind,
    runtimeRoot: layout.runtimeRoot,
    hlslGrammar,
  });
}

export function tryResolveParserRuntimeAssets(
  moduleFile: string,
): ParserRuntimeAssets | undefined {
  try {
    return resolveParserRuntimeAssets(moduleFile);
  } catch {
    return undefined;
  }
}

export function resolveRunningParserRuntimeAssets(): ParserRuntimeAssets {
  return resolveParserRuntimeAssets(__filename);
}

/** Load from the exact captured bytes also used for cache compatibility. */
export async function loadHlslGrammar<T>(
  runtimeAssets: ParserRuntimeAssets,
  loader: (bytes: Uint8Array) => Promise<T>,
): Promise<T> {
  return loader(runtimeAssets.hlslGrammar.readBytes());
}

export function locateParserRuntimeAssets(moduleFile: string): ParserRuntimeLocation {
  moduleFile = resolve(moduleFile);
  const moduleDirectory = dirname(moduleFile);
  const moduleName = basename(moduleFile);

  if (moduleName === 'server.js') {
    const directoryName = basename(moduleDirectory);
    const parentName = basename(dirname(moduleDirectory));
    if (directoryName === 'out' && parentName === 'server') {
      return {
        kind: 'tsc-out',
        runtimeRoot: moduleDirectory,
        grammarPath: join(dirname(moduleDirectory), 'grammars', HLSL_GRAMMAR_NAME),
      };
    }
    if (directoryName === 'server' && parentName === 'out') {
      return {
        kind: 'bundled-server',
        runtimeRoot: moduleDirectory,
        grammarPath: join(dirname(moduleDirectory), 'grammars', HLSL_GRAMMAR_NAME),
      };
    }
    throw unsupportedLayout(moduleFile);
  }

  const runtimeRoot = resolve(moduleDirectory, '..');
  const runtimeRootName = basename(runtimeRoot);
  const runtimeParentName = basename(dirname(runtimeRoot));
  if (runtimeRootName === 'src' && runtimeParentName === 'server') {
    return {
      kind: 'source',
      runtimeRoot,
      grammarPath: join(dirname(runtimeRoot), 'grammars', HLSL_GRAMMAR_NAME),
    };
  }
  if (runtimeRootName === 'out' && runtimeParentName === 'server') {
    return {
      kind: 'tsc-out',
      runtimeRoot,
      grammarPath: join(dirname(runtimeRoot), 'grammars', HLSL_GRAMMAR_NAME),
    };
  }
  if (runtimeRootName === 'server' && runtimeParentName === 'out') {
    return {
      kind: 'copied-server',
      runtimeRoot,
      grammarPath: join(dirname(runtimeRoot), 'grammars', HLSL_GRAMMAR_NAME),
    };
  }
  throw unsupportedLayout(moduleFile);
}

function unsupportedLayout(moduleFile: string): ParserRuntimeAssetsError {
  return new ParserRuntimeAssetsError(
    `Unsupported parser runtime layout for ${moduleFile}; expected source, tsc-out, copied-server, or bundled-server`,
  );
}

export function moduleBelongsToRuntime(
  moduleFile: string,
  runtimeAssets: ParserRuntimeAssets,
): boolean {
  const moduleRelative = relative(runtimeAssets.runtimeRoot, resolve(moduleFile));
  return moduleRelative !== ''
    && moduleRelative !== '..'
    && !moduleRelative.startsWith(`..${sep}`)
    && !isAbsolute(moduleRelative);
}
