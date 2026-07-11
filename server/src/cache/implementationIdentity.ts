import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  locateParserRuntimeAssets,
  moduleBelongsToRuntime,
  type ParserRuntimeAssets,
  type ParserRuntimeLayout,
} from '../parser/runtimeAssets';

const HASH_DOMAIN = Buffer.from('UnityShaderNav:index-implementation:v2\0', 'utf8');

interface IdentityInput {
  readonly logicalPath: string;
  readonly bytes: Buffer;
}

export interface CapturedIndexImplementation {
  identityFor(runtimeAssets: ParserRuntimeAssets): string | undefined;
}

/**
 * Capture every non-grammar runtime byte that can influence FileIndex output.
 * The grammar is supplied only after parser initialization succeeds, allowing
 * ADR-0006 recovery without letting a watch overwrite change this process's
 * already-running implementation identity.
 */
export function captureIndexImplementationForModule(
  moduleFile: string,
): CapturedIndexImplementation | undefined {
  try {
    const absoluteModule = resolve(moduleFile);
    const location = locateParserRuntimeAssets(absoluteModule);
    const requireFromModule = createRequire(absoluteModule);
    const webTreeSitterPackage = requireFromModule.resolve('web-tree-sitter/package.json');
    const webTreeSitterRoot = dirname(webTreeSitterPackage);
    const webTreeSitterEntry = requireFromModule.resolve('web-tree-sitter');
    const sharedPackage = location.kind === 'bundled-server'
      ? undefined
      : requireFromModule.resolve('@unity-shader-nav/shared/package.json');
    const inputs = implementationInputs(
      absoluteModule,
      location.kind,
      location.runtimeRoot,
      sharedPackage,
    );

    inputs.push(...readTreeInputs(webTreeSitterRoot, 'web-tree-sitter'));
    // Resolving the public entry is also a loadability check. Hash it under a
    // fixed logical name in case a package entry resolves outside its root.
    inputs.push(readInput('web-tree-sitter/runtime-entry', webTreeSitterEntry));
    inputs.push(readInput(
      'web-tree-sitter/runtime-wasm',
      join(webTreeSitterRoot, 'tree-sitter.wasm'),
    ));
    const identities = new WeakMap<ParserRuntimeAssets, string>();

    return Object.freeze({
      identityFor(runtimeAssets: ParserRuntimeAssets): string | undefined {
        if (
          runtimeAssets.layout !== location.kind
          || resolve(runtimeAssets.runtimeRoot) !== resolve(location.runtimeRoot)
          || !moduleBelongsToRuntime(absoluteModule, runtimeAssets)
        ) return undefined;

        const existing = identities.get(runtimeAssets);
        if (existing) return existing;
        const identity = hashIdentityInputs([
          ...inputs,
          {
            logicalPath: 'parser/tree-sitter-hlsl.wasm',
            bytes: Buffer.from(runtimeAssets.hlslGrammar.readBytes()),
          },
        ]);
        identities.set(runtimeAssets, identity);
        return identity;
      },
    });
  } catch {
    return undefined;
  }
}

/** Content-address the implementation and exact grammar bytes for a layout. */
export function implementationIdentityForModule(
  moduleFile: string,
  runtimeAssets: ParserRuntimeAssets,
): string | undefined {
  return captureIndexImplementationForModule(moduleFile)?.identityFor(runtimeAssets);
}

function implementationInputs(
  moduleFile: string,
  layout: ParserRuntimeLayout,
  runtimeRoot: string,
  sharedPackage: string | undefined,
): IdentityInput[] {
  if (layout === 'bundled-server') {
    return [readInput('server/server.js', moduleFile)];
  }

  if (!sharedPackage) throw new Error('shared runtime package is unavailable');
  const sharedOut = join(dirname(sharedPackage), 'out');
  if (layout === 'copied-server') {
    return [
      ...readTreeInputs(
        runtimeRoot,
        'server/copied',
        '.js',
        new Set(['node_modules']),
      ),
      ...readTreeInputs(sharedOut, 'shared/out', '.js'),
    ];
  }

  const treeKind = layout === 'source' ? 'src' : 'out';
  return [
    ...readTreeInputs(
      runtimeRoot,
      `server/${treeKind}`,
      layout === 'source' ? '.ts' : '.js',
    ),
    ...readTreeInputs(sharedOut, 'shared/out', '.js'),
  ];
}

function readTreeInputs(
  root: string,
  logicalRoot: string,
  extension?: string,
  skippedDirectories: ReadonlySet<string> = new Set(),
): IdentityInput[] {
  const inputs: IdentityInput[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && (!extension || extname(entry.name) === extension)) {
        const relativePath = relative(root, path).split(sep).join('/');
        inputs.push(readInput(`${logicalRoot}/${relativePath}`, path));
      }
    }
  };
  visit(root);
  return inputs;
}

function readInput(logicalPath: string, path: string): IdentityInput {
  return { logicalPath, bytes: readFileSync(path) };
}

function hashIdentityInputs(inputs: IdentityInput[]): string {
  const sorted = [...inputs].sort((a, b) => (
    a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0
  ));
  const hash = createHash('sha256').update(HASH_DOMAIN);
  let previousPath: string | undefined;
  for (const input of sorted) {
    if (input.logicalPath === previousPath) {
      throw new Error(`duplicate implementation input ${input.logicalPath}`);
    }
    previousPath = input.logicalPath;
    updateFramed(hash, Buffer.from(input.logicalPath, 'utf8'));
    updateFramed(hash, input.bytes);
  }
  return hash.digest('hex');
}

function updateFramed(hash: ReturnType<typeof createHash>, bytes: Buffer): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

const RUNNING_INDEX_IMPLEMENTATION = captureIndexImplementationForModule(__filename);

export function runningIndexImplementationIdentity(
  runtimeAssets: ParserRuntimeAssets,
): string | undefined {
  return RUNNING_INDEX_IMPLEMENTATION?.identityFor(runtimeAssets);
}
