import { describe, expect, it, vi } from 'vitest';
import {
  basename,
  dirname,
  join,
  parse,
  resolve as pathResolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInclude, type FileProbe } from '../../src/include';
import type { IncludeContext } from '../../src/include/types';

const projectRoot = pathResolve('virtual-unity-project');
const fromFile = join(projectRoot, 'Assets', 'Shaders', 'Main.shader');
const fromUri = pathToFileURL(fromFile).href;

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
    const absolutePath = pathResolve(path);
    return this.paths.has(absolutePath)
      || (this.caseInsensitiveExists && this.lowerCasePaths.has(absolutePath.toLowerCase()));
  }

  async listDir(path: string): Promise<readonly string[]> {
    const absolutePath = pathResolve(path);
    const entries = this.entriesByDirectory.get(absolutePath);
    if (!entries) throw new Error(`not a directory: ${absolutePath}`);
    return [...entries];
  }

  private addPath(path: string): void {
    let current = pathResolve(path);
    const root = parse(current).root;
    this.remember(current);

    while (current !== root) {
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

function context(overrides: Partial<IncludeContext> = {}): IncludeContext {
  return {
    unityProjectRoot: projectRoot,
    includeDirectories: [],
    ...overrides,
  };
}

describe('resolveInclude', () => {
  it('resolves an exact-case path relative to the including file', async () => {
    const target = join(projectRoot, 'Assets', 'Shaders', 'Inner', 'Lighting.hlsl');
    const probe = new MemoryFileProbe([fromFile, target]);

    await expect(resolveInclude('Inner/Lighting.hlsl', fromUri, context(), probe))
      .resolves.toEqual({
        absolutePath: target,
        via: 'relative',
        caseInsensitive: false,
      });
  });

  it('trusts inherited filesystem aliases while checking the authored suffix', async () => {
    const aliasedRoot = pathResolve('virtual-alias-parent', 'SHORT~1');
    const aliasedFromFile = join(aliasedRoot, 'Assets', 'Shaders', 'Main.shader');
    const target = join(aliasedRoot, 'Assets', 'Shaders', 'Lighting.hlsl');
    const memory = new MemoryFileProbe([aliasedFromFile, target]);
    const aliasParent = dirname(aliasedRoot);
    const listDir = vi.fn(async (path: string) => {
      if (pathResolve(path) === aliasParent) return ['LongActualName'];
      return memory.listDir(path);
    });
    const probe: FileProbe = {
      exists: (path) => memory.exists(path),
      listDir,
    };

    await expect(resolveInclude(
      'Lighting.hlsl',
      pathToFileURL(aliasedFromFile).href,
      context({ unityProjectRoot: aliasedRoot }),
      probe,
    )).resolves.toEqual({
      absolutePath: target,
      via: 'relative',
      caseInsensitive: false,
    });
    expect(listDir).not.toHaveBeenCalledWith(aliasParent);
  });

  it('preserves an inherited alias while correcting authored suffix casing', async () => {
    const aliasedRoot = pathResolve('virtual-alias-parent', 'SHORT~1');
    const aliasedFromFile = join(aliasedRoot, 'Assets', 'Shaders', 'Main.shader');
    const target = join(aliasedRoot, 'Assets', 'Shaders', 'lighting.hlsl');
    const memory = new MemoryFileProbe([aliasedFromFile, target], true);
    const aliasParent = dirname(aliasedRoot);
    const listDir = vi.fn(async (path: string) => {
      if (pathResolve(path) === aliasParent) return ['LongActualName'];
      return memory.listDir(path);
    });
    const probe: FileProbe = {
      exists: (path) => memory.exists(path),
      listDir,
    };

    await expect(resolveInclude(
      'Lighting.hlsl',
      pathToFileURL(aliasedFromFile).href,
      context({ unityProjectRoot: aliasedRoot }),
      probe,
    )).resolves.toEqual({
      absolutePath: target,
      via: 'relative',
      caseInsensitive: true,
    });
    expect(listDir).not.toHaveBeenCalledWith(aliasParent);
  });

  it('checks the normalized authored suffix after dot-segment resolution', async () => {
    const target = join(projectRoot, 'Assets', 'Shaders', 'Lighting.hlsl');
    const probe = new MemoryFileProbe([fromFile, target]);

    await expect(resolveInclude(
      'Ghost/../Lighting.hlsl',
      fromUri,
      context(),
      probe,
    )).resolves.toEqual({
      absolutePath: target,
      via: 'relative',
      caseInsensitive: false,
    });
  });

  it('checks the conventional Assets segment instead of trusting its spelling', async () => {
    const actualAssets = join(projectRoot, 'assets');
    const target = join(actualAssets, 'Lighting.hlsl');
    const probe: FileProbe = {
      async exists(path) {
        return pathResolve(path).toLowerCase() === target.toLowerCase();
      },
      async listDir(path) {
        const normalized = pathResolve(path).toLowerCase();
        if (normalized === projectRoot.toLowerCase()) return ['assets'];
        if (normalized === actualAssets.toLowerCase()) return ['Lighting.hlsl'];
        throw new Error(`not a directory: ${path}`);
      },
    };

    await expect(resolveInclude(
      'Lighting.hlsl',
      fromUri,
      context(),
      probe,
    )).resolves.toEqual({
      absolutePath: target,
      via: 'assets',
      caseInsensitive: true,
    });
  });

  it('falls back to the project Assets root', async () => {
    const target = join(projectRoot, 'Assets', 'CustomCG', 'MyHelper.hlsl');
    const probe = new MemoryFileProbe([fromFile, target]);

    await expect(resolveInclude('CustomCG/MyHelper.hlsl', fromUri, context(), probe))
      .resolves.toEqual({
        absolutePath: target,
        via: 'assets',
        caseInsensitive: false,
      });
  });

  it('searches configured include directories in order', async () => {
    const firstDirectory = pathResolve('virtual-includes-first');
    const secondDirectory = pathResolve('virtual-includes-second');
    const firstTarget = join(firstDirectory, 'MyHelper.hlsl');
    const secondTarget = join(secondDirectory, 'MyHelper.hlsl');
    const probe = new MemoryFileProbe([fromFile, firstTarget, secondTarget]);

    await expect(resolveInclude(
      'MyHelper.hlsl',
      fromUri,
      context({
        unityProjectRoot: undefined,
        includeDirectories: [firstDirectory, secondDirectory],
      }),
      probe,
    )).resolves.toEqual({
      absolutePath: firstTarget,
      via: 'includeDirectories',
      caseInsensitive: false,
    });
  });

  it('maps Packages paths through the resolved physical package root', async () => {
    const packageRoot = pathResolve('virtual-package-cache', 'com.example.urp');
    const target = join(packageRoot, 'ShaderLibrary', 'Core.hlsl');
    const probe = new MemoryFileProbe([fromFile, target]);

    await expect(resolveInclude(
      'Packages/com.example.urp/ShaderLibrary/Core.hlsl',
      fromUri,
      context({
        packagePhysicalPaths: new Map([['com.example.urp', packageRoot]]),
      }),
      probe,
    )).resolves.toEqual({
      absolutePath: target,
      via: 'package',
      caseInsensitive: false,
    });
  });

  it('keeps a package subpath with repeated separators under the package root', async () => {
    const packageRoot = pathResolve('virtual-package-cache', 'com.example.urp');
    const target = join(packageRoot, 'ShaderLibrary', 'Core.hlsl');
    const probe = new MemoryFileProbe([fromFile, target]);

    await expect(resolveInclude(
      'Packages/com.example.urp//ShaderLibrary/Core.hlsl',
      fromUri,
      context({
        packagePhysicalPaths: new Map([['com.example.urp', packageRoot]]),
      }),
      probe,
    )).resolves.toEqual({
      absolutePath: target,
      via: 'package',
      caseInsensitive: false,
    });
  });

  it('prefers any exact-case candidate over an earlier case-insensitive candidate', async () => {
    const relativeFallback = join(projectRoot, 'Assets', 'Shaders', 'helper.hlsl');
    const assetsExact = join(projectRoot, 'Assets', 'Helper.hlsl');
    const probe = new MemoryFileProbe(
      [fromFile, relativeFallback, assetsExact],
      true,
    );

    await expect(resolveInclude('Helper.hlsl', fromUri, context(), probe))
      .resolves.toEqual({
        absolutePath: assetsExact,
        via: 'assets',
        caseInsensitive: false,
      });
  });

  it('returns the on-disk spelling and warning flag for case-insensitive fallback', async () => {
    const target = join(projectRoot, 'Assets', 'Shaders', 'helper.hlsl');
    const probe = new MemoryFileProbe([fromFile, target], true);

    await expect(resolveInclude('Helper.hlsl', fromUri, context(), probe))
      .resolves.toEqual({
        absolutePath: target,
        via: 'relative',
        caseInsensitive: true,
      });
  });

  it('applies case-insensitive fallback to mapped package paths', async () => {
    const packageRoot = pathResolve('virtual-package-cache', 'com.example.urp');
    const target = join(packageRoot, 'ShaderLibrary', 'core.hlsl');
    const probe = new MemoryFileProbe([fromFile, target], true);

    await expect(resolveInclude(
      'Packages/com.example.urp/ShaderLibrary/Core.hlsl',
      fromUri,
      context({
        packagePhysicalPaths: new Map([['com.example.urp', packageRoot]]),
      }),
      probe,
    )).resolves.toEqual({
      absolutePath: target,
      via: 'package',
      caseInsensitive: true,
    });
  });

  it('resolves an absolute include without adding other candidates', async () => {
    const target = pathResolve('virtual-absolute-includes', 'Absolute.hlsl');
    const probe = new MemoryFileProbe([fromFile, target]);

    await expect(resolveInclude(target, fromUri, context(), probe)).resolves.toEqual({
      absolutePath: target,
      via: 'relative',
      caseInsensitive: false,
    });
  });

  it('returns null when no candidate exists', async () => {
    const probe = new MemoryFileProbe([fromFile]);

    await expect(resolveInclude('Missing.hlsl', fromUri, context(), probe))
      .resolves.toBeNull();
  });

  it('does not probe when the including document URI is invalid', async () => {
    const probe: FileProbe = {
      exists: vi.fn(async () => true),
      listDir: vi.fn(async () => []),
    };

    await expect(resolveInclude('Common.hlsl', 'not-a-file-uri', context(), probe))
      .resolves.toBeNull();
    expect(probe.exists).not.toHaveBeenCalled();
    expect(probe.listDir).not.toHaveBeenCalled();
  });

  it('does not fall through when a Packages mapping is absent', async () => {
    const probe: FileProbe = {
      exists: vi.fn(async () => true),
      listDir: vi.fn(async () => []),
    };

    await expect(resolveInclude(
      'Packages/com.example.missing/Core.hlsl',
      fromUri,
      context(),
      probe,
    )).resolves.toBeNull();
    expect(probe.exists).not.toHaveBeenCalled();
    expect(probe.listDir).not.toHaveBeenCalled();
  });

  it('continues to later candidates after a directory-read failure', async () => {
    const includePath = 'Unreadable.hlsl';
    const relativeCandidate = join(projectRoot, 'Assets', 'Shaders', includePath);
    const assetsTarget = join(projectRoot, 'Assets', includePath);
    const memory = new MemoryFileProbe([fromFile, assetsTarget]);
    const probe: FileProbe = {
      async exists(path) {
        return pathResolve(path) === relativeCandidate || memory.exists(path);
      },
      async listDir(path) {
        if (pathResolve(path) === dirname(relativeCandidate)) {
          throw new Error('permission denied');
        }
        return memory.listDir(path);
      },
    };

    await expect(resolveInclude(includePath, fromUri, context(), probe))
      .resolves.toEqual({
        absolutePath: assetsTarget,
        via: 'assets',
        caseInsensitive: false,
      });
  });

  it('treats directory-read failures as unresolved candidates', async () => {
    const probe: FileProbe = {
      exists: vi.fn(async () => true),
      listDir: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    };

    await expect(resolveInclude('Unreadable.hlsl', fromUri, context(), probe))
      .resolves.toBeNull();
  });
});
