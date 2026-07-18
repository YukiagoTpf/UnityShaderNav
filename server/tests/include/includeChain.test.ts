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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it('coalesces concurrent resolution and caches an unresolved result', async () => {
    const mainPath = join(root, 'Assets', 'Main.hlsl');
    const missingPath = join(root, 'Assets', 'Missing.hlsl');
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<boolean>();
    const probe: FileProbe = {
      exists: vi.fn(async () => {
        probeStarted.resolve();
        return releaseProbe.promise;
      }),
      listDir: vi.fn(async () => {
        throw new Error('not a directory');
      }),
    };
    const chain = createIncludeChain({ get: () => undefined }, context(), probe);

    const first = chain.resolve(missingPath, pathToFileURL(mainPath).href);
    await probeStarted.promise;
    const concurrent = chain.resolve(missingPath, pathToFileURL(mainPath).href);

    expect(probe.exists).toHaveBeenCalledTimes(1);
    releaseProbe.resolve(false);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([null, null]);
    expect(probe.listDir).toHaveBeenCalledTimes(1);

    await expect(chain.resolve(missingPath, pathToFileURL(mainPath).href))
      .resolves.toBeNull();
    expect(probe.exists).toHaveBeenCalledTimes(1);
    expect(probe.listDir).toHaveBeenCalledTimes(1);
  });

  it('coalesces visible closure traversal without exposing the cached set', async () => {
    const aPath = join(root, 'Assets', 'VisibleA.hlsl');
    const bPath = join(root, 'Assets', 'VisibleB.hlsl');
    const indexes = [file(aPath, ['VisibleB.hlsl']), file(bPath, [])];
    const byUri = new Map(indexes.map((entry) => [uriKey(entry.uri), entry]));
    const get = vi.fn((uri: string) => byUri.get(uriKey(uri)));
    const chain = createIncludeChain(
      { get },
      context(),
      new MemoryFileProbe([aPath, bPath]),
    );
    const rootUri = pathToFileURL(aPath).href;
    const expected = [aPath, bPath]
      .map((path) => uriKey(pathToFileURL(path).href))
      .sort();

    const [first, concurrent] = await Promise.all([
      chain.visibleUriKeys(rootUri),
      chain.visibleUriKeys(rootUri),
    ]);

    expect([...first].sort()).toEqual(expected);
    expect([...concurrent].sort()).toEqual(expected);
    expect(get).toHaveBeenCalledTimes(2);

    const mutable = first as Set<string>;
    if (typeof mutable.clear === 'function') {
      mutable.clear();
      mutable.add('poisoned-by-caller');
    }

    const afterCallerMutation = await chain.visibleUriKeys(rootUri);
    expect([...afterCallerMutation].sort()).toEqual(expected);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('shares directory listings within one chain and starts a new chain cold', async () => {
    const mainPath = join(root, 'Assets', 'Main.hlsl');
    const firstPath = join(root, 'Assets', 'First.hlsl');
    const secondPath = join(root, 'Assets', 'Second.hlsl');
    const probe = new MemoryFileProbe([mainPath, firstPath, secondPath]);
    const listDir = vi.spyOn(probe, 'listDir');
    const exists = vi.spyOn(probe, 'exists');
    const chain = createIncludeChain({ get: () => undefined }, context(), probe);
    const mainUri = pathToFileURL(mainPath).href;

    await expect(Promise.all([
      chain.resolve('First.hlsl', mainUri),
      chain.resolve('Second.hlsl', mainUri),
    ])).resolves.toEqual([
      { absolutePath: firstPath, via: 'relative', caseInsensitive: false },
      { absolutePath: secondPath, via: 'relative', caseInsensitive: false },
    ]);

    const assetsDirectory = pathResolve(dirname(firstPath));
    const assetsReads = () => listDir.mock.calls.filter(
      ([path]) => pathResolve(path) === assetsDirectory,
    ).length;
    expect(assetsReads()).toBe(1);
    expect(exists).toHaveBeenCalledTimes(2);

    const listingCount = listDir.mock.calls.length;
    await expect(chain.resolve('First.hlsl', mainUri)).resolves.toEqual({
      absolutePath: firstPath,
      via: 'relative',
      caseInsensitive: false,
    });
    expect(listDir).toHaveBeenCalledTimes(listingCount);
    expect(exists).toHaveBeenCalledTimes(2);

    const nextChain = createIncludeChain({ get: () => undefined }, context(), probe);
    await expect(nextChain.resolve('First.hlsl', mainUri)).resolves.toEqual({
      absolutePath: firstPath,
      via: 'relative',
      caseInsensitive: false,
    });
    expect(assetsReads()).toBe(2);
    expect(exists).toHaveBeenCalledTimes(3);
  });

  it('shares a directory-read rejection and caches the resulting misses', async () => {
    const mainPath = join(root, 'Assets', 'Main.hlsl');
    const firstPath = join(root, 'Assets', 'UnreadableFirst.hlsl');
    const secondPath = join(root, 'Assets', 'UnreadableSecond.hlsl');
    const probe: FileProbe = {
      exists: vi.fn(async () => true),
      listDir: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    };
    const chain = createIncludeChain({ get: () => undefined }, context(), probe);
    const mainUri = pathToFileURL(mainPath).href;

    await expect(Promise.all([
      chain.resolve(firstPath, mainUri),
      chain.resolve(secondPath, mainUri),
    ])).resolves.toEqual([null, null]);
    expect(probe.listDir).toHaveBeenCalledTimes(1);

    await expect(chain.resolve(firstPath, mainUri)).resolves.toBeNull();
    expect(probe.exists).toHaveBeenCalledTimes(2);
    expect(probe.listDir).toHaveBeenCalledTimes(1);
  });
});
