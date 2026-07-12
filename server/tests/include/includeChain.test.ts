import {
  basename,
  dirname,
  join,
  parse,
  resolve as pathResolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FileIndex, ReferenceEntry } from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createIncludeChain,
  type FileProbe,
  type IncludeContext,
} from '../../src/include';
import { uriKey } from '../../src/uriKey';

const root = pathResolve('virtual-include-chain');

class MemoryFileProbe implements FileProbe {
  private readonly paths = new Set<string>();
  private readonly lowerCasePaths = new Set<string>();
  private readonly entriesByDirectory = new Map<string, Set<string>>();

  constructor(
    paths: readonly string[],
    private readonly caseInsensitiveExists = false,
  ) {
    for (const path of paths) this.addPath(path);
  }

  async exists(path: string): Promise<boolean> {
    const absolute = pathResolve(path);
    return this.paths.has(absolute)
      || (this.caseInsensitiveExists && this.lowerCasePaths.has(absolute.toLowerCase()));
  }

  async listDir(path: string): Promise<readonly string[]> {
    const entries = this.entriesByDirectory.get(pathResolve(path));
    if (!entries) throw new Error(`not a directory: ${path}`);
    return [...entries];
  }

  private addPath(path: string): void {
    let current = pathResolve(path);
    const rootPath = parse(current).root;
    this.remember(current);
    while (current !== rootPath) {
      const parent = dirname(current);
      const entries = this.entriesByDirectory.get(parent) ?? new Set<string>();
      entries.add(basename(current));
      this.entriesByDirectory.set(parent, entries);
      this.remember(parent);
      current = parent;
    }
  }

  private remember(path: string): void {
    this.paths.add(path);
    this.lowerCasePaths.add(path.toLowerCase());
  }
}

function includeReference(uri: string, name: string): ReferenceEntry {
  return {
    name,
    context: 'include',
    location: {
      uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: name.length },
      },
    },
  };
}

function file(path: string, includes: readonly string[]): FileIndex {
  const uri = pathToFileURL(path).href;
  return {
    uri,
    symbols: [],
    references: includes.map((name) => includeReference(uri, name)),
  };
}

function context(overrides: Partial<IncludeContext> = {}): IncludeContext {
  return {
    unityProjectRoot: root,
    includeDirectories: [],
    ...overrides,
  };
}

describe('IncludeChain', () => {
  it('traverses multi-level includes, terminates cycles, and stops at a missing index', async () => {
    const aPath = join(root, 'Assets', 'A.hlsl');
    const bPath = join(root, 'Assets', 'B.hlsl');
    const cPath = join(root, 'Assets', 'C.hlsl');
    const missingIndexPath = join(root, 'Assets', 'MissingIndex.hlsl');
    const unreachablePath = join(root, 'Assets', 'Unreachable.hlsl');
    const indexes = [
      file(aPath, ['B.hlsl']),
      file(bPath, ['C.hlsl']),
      file(cPath, ['A.hlsl', 'MissingIndex.hlsl']),
      file(unreachablePath, []),
    ];
    const byUri = new Map(indexes.map((index) => [uriKey(index.uri), index]));
    const probe = new MemoryFileProbe([
      aPath,
      bPath,
      cPath,
      missingIndexPath,
      unreachablePath,
    ]);
    const chain = createIncludeChain(
      { get: (uri) => byUri.get(uriKey(uri)) },
      context(),
      probe,
    );

    const visible = await chain.visibleUriKeys(pathToFileURL(aPath).href);

    expect([...visible].sort()).toEqual([
      aPath,
      bPath,
      cPath,
      missingIndexPath,
    ].map((path) => uriKey(pathToFileURL(path).href)).sort());
    expect(visible.has(uriKey(pathToFileURL(unreachablePath).href))).toBe(false);
  });

  it('composes the FileProbe with package mapping and case-insensitive fallback', async () => {
    const mainPath = join(root, 'Assets', 'Main.hlsl');
    const packageRoot = pathResolve('virtual-chain-package', 'com.example.rendering');
    const packagePath = join(packageRoot, 'ShaderLibrary', 'core.hlsl');
    const probe = new MemoryFileProbe([mainPath, packagePath], true);
    const get = vi.fn(() => undefined);
    const chain = createIncludeChain(
      { get },
      context({
        packagePhysicalPaths: new Map([['com.example.rendering', packageRoot]]),
      }),
      probe,
    );

    await expect(chain.resolve(
      'Packages/com.example.rendering/ShaderLibrary/Core.hlsl',
      pathToFileURL(mainPath).href,
    )).resolves.toEqual({
      absolutePath: packagePath,
      via: 'package',
      caseInsensitive: true,
    });

    const withoutMapping = createIncludeChain({ get }, context(), probe);
    await expect(withoutMapping.resolve(
      'Packages/com.example.rendering/ShaderLibrary/Core.hlsl',
      pathToFileURL(mainPath).href,
    )).resolves.toBeNull();
  });
});
