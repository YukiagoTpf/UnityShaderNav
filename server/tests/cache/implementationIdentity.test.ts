import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { implementationIdentityForModule } from '../../src/cache/implementationIdentity';
import { tryResolveParserRuntimeAssets } from '../../src/parser/runtimeAssets';

describe('implementationIdentityForModule bundled adapter', () => {
  it('is independent of the installation root and changes with every runtime input', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'usn-identity-bundle-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'usn-identity-bundle-b-'));
    const alternateRoot = await mkdtemp(join(tmpdir(), 'usn-identity-bundle-main-'));
    try {
      const firstBundle = await writeBundledRuntime(firstRoot);
      const secondBundle = await writeBundledRuntime(secondRoot, true);
      const baseline = identityFor(firstBundle);

      expect(baseline).toMatch(/^[0-9a-f]{64}$/);
      expect(identityFor(secondBundle)).toBe(baseline);

      await writeFile(firstBundle, 'server bundle changed\n');
      expect(identityFor(firstBundle)).not.toBe(baseline);
      await writeFile(firstBundle, 'server bundle\n');

      const runtimeRoot = join(firstRoot, 'out', 'server', 'node_modules', 'web-tree-sitter');
      for (const [name, changed] of [
        ['package.json', '{"name":"web-tree-sitter","main":"tree-sitter.js","changed":true}\n'],
        ['tree-sitter.js', 'runtime js changed\n'],
        ['tree-sitter.wasm', 'runtime wasm changed\n'],
      ] as const) {
        await writeFile(join(runtimeRoot, name), changed);
        expect(identityFor(firstBundle)).not.toBe(baseline);
        await writeWebRuntime(runtimeRoot);
      }

      const alternateBundle = await writeBundledRuntime(
        alternateRoot,
        false,
        'alternate.js',
      );
      const alternateRuntimeRoot = join(
        alternateRoot,
        'out',
        'server',
        'node_modules',
        'web-tree-sitter',
      );
      const alternateBaseline = identityFor(alternateBundle);
      expect(alternateBaseline).toMatch(/^[0-9a-f]{64}$/);

      await writeFile(join(alternateRuntimeRoot, 'helper.js'), 'helper runtime B\n');
      expect(identityFor(alternateBundle)).not.toBe(alternateBaseline);

      await writeFile(
        join(alternateRoot, 'out', 'grammars', 'tree-sitter-hlsl.wasm'),
        'grammar runtime B\n',
      );
      expect(identityFor(alternateBundle)).not.toBe(alternateBaseline);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
      await rm(alternateRoot, { recursive: true, force: true });
    }
  });

  it('returns unavailable when a required runtime input is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-identity-missing-'));
    try {
      const bundle = await writeBundledRuntime(root);
      await rm(join(root, 'out', 'server', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'));
      expect(identityFor(bundle)).toBeUndefined();

      await writeWebRuntime(join(root, 'out', 'server', 'node_modules', 'web-tree-sitter'));
      await rm(join(root, 'out', 'grammars', 'tree-sitter-hlsl.wasm'));
      expect(identityFor(bundle)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.each([
  { tree: 'src', extension: 'ts' },
  { tree: 'out', extension: 'js' },
])('implementationIdentityForModule unbundled $tree adapter', ({ tree, extension }) => {
  it('tracks production code but excludes tests, fixtures, and docs', async () => {
    const root = await mkdtemp(join(tmpdir(), `usn-identity-${tree}-`));
    try {
      const moduleFile = join(root, 'server', tree, 'cache', `implementationIdentity.${extension}`);
      const implementationFile = join(root, 'server', tree, 'parser', `indexer.${extension}`);
      const ignoredTest = join(root, 'server', 'tests', `indexer.test.${extension}`);
      const ignoredDoc = join(root, 'docs', 'notes.md');
      await mkdir(join(root, 'server', tree, 'cache'), { recursive: true });
      await mkdir(join(root, 'server', tree, 'parser'), { recursive: true });
      await mkdir(join(root, 'server', 'tests'), { recursive: true });
      await mkdir(join(root, 'server', 'grammars'), { recursive: true });
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(moduleFile, 'identity module\n');
      await writeFile(implementationFile, 'index implementation\n');
      await writeFile(join(root, 'server', 'grammars', 'tree-sitter-hlsl.wasm'), 'grammar runtime\n');
      await writeFile(ignoredTest, 'test fixture\n');
      await writeFile(ignoredDoc, 'documentation\n');
      await writeWebRuntime(join(root, 'node_modules', 'web-tree-sitter'));
      await writeSharedRuntime(root);

      const baseline = identityFor(moduleFile);
      expect(baseline).toMatch(/^[0-9a-f]{64}$/);

      await writeFile(ignoredTest, 'changed test fixture\n');
      await writeFile(ignoredDoc, 'changed documentation\n');
      expect(identityFor(moduleFile)).toBe(baseline);

      await writeFile(implementationFile, 'changed index implementation\n');
      expect(identityFor(moduleFile)).not.toBe(baseline);
      await writeFile(implementationFile, 'index implementation\n');

      await writeFile(
        join(root, 'node_modules', '@unity-shader-nav', 'shared', 'out', 'index.js'),
        'changed shared runtime\n',
      );
      expect(identityFor(moduleFile)).not.toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('identifies the copied-server tree and its external shared runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-identity-copied-'));
  try {
    const serverRoot = join(root, 'client', 'out', 'server');
    const moduleFile = join(serverRoot, 'cache', 'implementationIdentity.js');
    await mkdir(join(serverRoot, 'cache'), { recursive: true });
    await mkdir(join(serverRoot, 'parser'), { recursive: true });
    await mkdir(join(root, 'client', 'out', 'grammars'), { recursive: true });
    await writeFile(moduleFile, 'identity module\n');
    await writeFile(join(serverRoot, 'parser', 'indexer.js'), 'index implementation\n');
    await writeFile(
      join(root, 'client', 'out', 'grammars', 'tree-sitter-hlsl.wasm'),
      'grammar runtime\n',
    );
    await writeWebRuntime(join(serverRoot, 'node_modules', 'web-tree-sitter'));
    await writeSharedRuntime(root);

    const baseline = identityFor(moduleFile);
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(
      join(root, 'node_modules', '@unity-shader-nav', 'shared', 'out', 'index.js'),
      'changed shared runtime\n',
    );
    expect(identityFor(moduleFile)).not.toBe(baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeBundledRuntime(
  root: string,
  runtimeFirst = false,
  runtimeEntry = 'tree-sitter.js',
): Promise<string> {
  const serverRoot = join(root, 'out', 'server');
  const runtimeRoot = join(serverRoot, 'node_modules', 'web-tree-sitter');
  await mkdir(serverRoot, { recursive: true });
  if (runtimeFirst) await writeWebRuntime(runtimeRoot, runtimeEntry);
  const bundle = join(serverRoot, 'server.js');
  await writeFile(bundle, 'server bundle\n');
  if (!runtimeFirst) await writeWebRuntime(runtimeRoot, runtimeEntry);
  await mkdir(join(root, 'out', 'grammars'), { recursive: true });
  await writeFile(
    join(root, 'out', 'grammars', 'tree-sitter-hlsl.wasm'),
    'grammar runtime A\n',
  );
  return bundle;
}

function identityFor(moduleFile: string): string | undefined {
  const runtimeAssets = tryResolveParserRuntimeAssets(moduleFile);
  return runtimeAssets
    ? implementationIdentityForModule(moduleFile, runtimeAssets)
    : undefined;
}

async function writeSharedRuntime(root: string): Promise<void> {
  const sharedRoot = join(root, 'node_modules', '@unity-shader-nav', 'shared');
  await mkdir(join(sharedRoot, 'out'), { recursive: true });
  await writeFile(
    join(sharedRoot, 'package.json'),
    '{"name":"@unity-shader-nav/shared","main":"out/index.js"}\n',
  );
  await writeFile(join(sharedRoot, 'out', 'index.js'), 'shared runtime\n');
}

async function writeWebRuntime(root: string, runtimeEntry = 'tree-sitter.js'): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `{\"name\":\"web-tree-sitter\",\"main\":\"${runtimeEntry}\"}\n`,
  );
  await writeFile(join(root, 'tree-sitter.js'), 'runtime js\n');
  if (runtimeEntry !== 'tree-sitter.js') {
    await writeFile(join(root, runtimeEntry), "module.exports = require('./helper.js');\n");
    await writeFile(join(root, 'helper.js'), 'helper runtime A\n');
  }
  await writeFile(join(root, 'tree-sitter.wasm'), 'runtime wasm\n');
}
