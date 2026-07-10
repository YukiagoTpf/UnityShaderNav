import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { implementationIdentityForModule } from '../../src/cache/implementationIdentity';

describe('implementationIdentityForModule bundled adapter', () => {
  it('is independent of the installation root and changes with every runtime input', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'usn-identity-bundle-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'usn-identity-bundle-b-'));
    const alternateRoot = await mkdtemp(join(tmpdir(), 'usn-identity-bundle-main-'));
    try {
      const firstBundle = await writeBundledRuntime(firstRoot);
      const secondBundle = await writeBundledRuntime(secondRoot, true);
      const baseline = implementationIdentityForModule(firstBundle);

      expect(baseline).toMatch(/^[0-9a-f]{64}$/);
      expect(implementationIdentityForModule(secondBundle)).toBe(baseline);

      await writeFile(firstBundle, 'server bundle changed\n');
      expect(implementationIdentityForModule(firstBundle)).not.toBe(baseline);
      await writeFile(firstBundle, 'server bundle\n');

      const runtimeRoot = join(firstRoot, 'out', 'server', 'node_modules', 'web-tree-sitter');
      for (const [name, changed] of [
        ['package.json', '{"name":"web-tree-sitter","main":"tree-sitter.js","changed":true}\n'],
        ['tree-sitter.js', 'runtime js changed\n'],
        ['tree-sitter.wasm', 'runtime wasm changed\n'],
      ] as const) {
        await writeFile(join(runtimeRoot, name), changed);
        expect(implementationIdentityForModule(firstBundle)).not.toBe(baseline);
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
      const alternateBaseline = implementationIdentityForModule(alternateBundle);
      expect(alternateBaseline).toMatch(/^[0-9a-f]{64}$/);

      await writeFile(join(alternateRuntimeRoot, 'helper.js'), 'helper runtime B\n');
      expect(implementationIdentityForModule(alternateBundle)).not.toBe(alternateBaseline);
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
      expect(implementationIdentityForModule(bundle)).toBeUndefined();
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
      await mkdir(join(root, 'shared', 'out'), { recursive: true });
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(moduleFile, 'identity module\n');
      await writeFile(implementationFile, 'index implementation\n');
      await writeFile(join(root, 'shared', 'out', 'index.js'), 'shared runtime\n');
      await writeFile(ignoredTest, 'test fixture\n');
      await writeFile(ignoredDoc, 'documentation\n');
      await writeWebRuntime(join(root, 'node_modules', 'web-tree-sitter'));

      const baseline = implementationIdentityForModule(moduleFile);
      expect(baseline).toMatch(/^[0-9a-f]{64}$/);

      await writeFile(ignoredTest, 'changed test fixture\n');
      await writeFile(ignoredDoc, 'changed documentation\n');
      expect(implementationIdentityForModule(moduleFile)).toBe(baseline);

      await writeFile(implementationFile, 'changed index implementation\n');
      expect(implementationIdentityForModule(moduleFile)).not.toBe(baseline);
      await writeFile(implementationFile, 'index implementation\n');

      await writeFile(join(root, 'shared', 'out', 'index.js'), 'changed shared runtime\n');
      expect(implementationIdentityForModule(moduleFile)).not.toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
  return bundle;
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
