import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const HASH_DOMAIN = Buffer.from('UnityShaderNav:index-implementation:v1\0', 'utf8');
interface IdentityInput {
  logicalPath: string;
  bytes: Buffer;
}

/**
 * Content-address the implementation that would execute from `moduleFile`.
 * Returning undefined disables cache reuse instead of sharing an "unknown"
 * identity between processes.
 */
export function implementationIdentityForModule(moduleFile: string): string | undefined {
  try {
    const requireFromModule = createRequire(moduleFile);
    const webTreeSitterPackage = requireFromModule.resolve('web-tree-sitter/package.json');
    const webTreeSitterRoot = dirname(webTreeSitterPackage);
    const webTreeSitterEntry = requireFromModule.resolve('web-tree-sitter');
    const inputs: IdentityInput[] = [];

    if (basename(moduleFile) === 'server.js') {
      inputs.push(readInput('server/server.js', moduleFile));
    } else {
      const serverTree = resolve(dirname(moduleFile), '..');
      const treeKind = basename(serverTree);
      if (treeKind !== 'src' && treeKind !== 'out') return undefined;

      const repositoryRoot = resolve(serverTree, '..', '..');
      inputs.push(...readTreeInputs(
        serverTree,
        `server/${treeKind}`,
        treeKind === 'src' ? '.ts' : '.js',
      ));
      inputs.push(...readTreeInputs(
        join(repositoryRoot, 'shared', 'out'),
        'shared/out',
        '.js',
      ));
    }

    inputs.push(...readTreeInputs(webTreeSitterRoot, 'web-tree-sitter'));
    // Resolving the public entry is also a loadability check. Hash it under a
    // fixed logical name in case a package entry resolves outside its root.
    inputs.push(readInput('web-tree-sitter/runtime-entry', webTreeSitterEntry));
    inputs.push(readInput(
      'web-tree-sitter/runtime-wasm',
      join(webTreeSitterRoot, 'tree-sitter.wasm'),
    ));
    return hashIdentityInputs(inputs);
  } catch {
    return undefined;
  }
}

function readTreeInputs(
  root: string,
  logicalRoot: string,
  extension?: string,
): IdentityInput[] {
  const inputs: IdentityInput[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
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

// Capture once at Module load. An old process must not adopt the identity of a
// bundle that a watch build overwrites later on disk.
export const INDEX_IMPLEMENTATION_IDENTITY = implementationIdentityForModule(__filename);
