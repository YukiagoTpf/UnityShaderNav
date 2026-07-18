import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import {
  createBundledThirdPartyNotices,
  writeBundledThirdPartyNotices,
} from './bundled-third-party-notices.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('two real bundle metafiles produce deterministic notices for every bundled package', async () => {
  const common = {
    absWorkingDir: repositoryRoot,
    alias: {
      '@unity-shader-nav/shared': resolve(repositoryRoot, 'shared/src/protocol.ts'),
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    minify: true,
    format: 'cjs',
    metafile: true,
    write: false,
  };
  const results = await Promise.all([
    build({ ...common, entryPoints: ['client/src/extension.ts'] }),
    build({ ...common, entryPoints: ['server/src/server.ts'] }),
  ]);
  const metafiles = results.map((result) => result.metafile);
  const expectedPackages = await bundledPackagesFrom(metafiles);

  assert(expectedPackages.length > 0, 'the runtime bundles must contain third-party packages');
  const notices = await createBundledThirdPartyNotices({ repositoryRoot, metafiles });
  const reversed = await createBundledThirdPartyNotices({
    repositoryRoot,
    metafiles: [...metafiles].reverse(),
  });

  assert.equal(reversed, notices);
  assert.equal(occurrences(notices, '\nPackage: '), expectedPackages.length);
  for (const bundledPackage of expectedPackages) {
    assert.match(
      notices,
      new RegExp([
        `Package: ${escapeRegExp(bundledPackage.name)}`,
        `Version: ${escapeRegExp(bundledPackage.version)}`,
        `License: ${escapeRegExp(bundledPackage.license)}`,
      ].join('\\n')),
    );
    for (const licenseText of bundledPackage.licenseTexts) {
      assert(
        notices.includes(licenseText),
        `notices must contain the original license text for ${bundledPackage.name}`,
      );
    }
  }
});

test('notice generation requires both runtime bundle metafiles', async () => {
  await assert.rejects(
    createBundledThirdPartyNotices({
      repositoryRoot,
      metafiles: [{ inputs: {} }],
    }),
    /third-party notices require exactly two esbuild metafiles/,
  );
});

for (const { label, manifest, invalidField } of [
  {
    label: 'a missing name',
    manifest: { version: '1.0.0', license: 'MIT' },
    invalidField: 'name',
  },
  {
    label: 'a blank name',
    manifest: { name: ' \t ', version: '1.0.0', license: 'MIT' },
    invalidField: 'name',
  },
  {
    label: 'a non-string name',
    manifest: { name: 1, version: '1.0.0', license: 'MIT' },
    invalidField: 'name',
  },
  {
    label: 'a missing version',
    manifest: { name: 'invalid-identity', license: 'MIT' },
    invalidField: 'version',
  },
  {
    label: 'a blank version',
    manifest: { name: 'invalid-identity', version: ' \t ', license: 'MIT' },
    invalidField: 'version',
  },
  {
    label: 'a non-string version',
    manifest: { name: 'invalid-identity', version: 1, license: 'MIT' },
    invalidField: 'version',
  },
]) {
  test(`notice generation rejects ${label} and removes stale output`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-third-party-notices-'));
    try {
      const packageRoot = join(root, 'node_modules/invalid-identity');
      const outputPath = join(root, 'THIRD_PARTY_NOTICES.txt');
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(packageRoot, 'LICENSE'), 'license text');
      await writeFile(outputPath, 'stale notices');

      await assert.rejects(
        writeBundledThirdPartyNotices({
          repositoryRoot: root,
          outputPath,
          metafiles: [
            { inputs: { 'node_modules/invalid-identity/index.js': {} } },
            { inputs: {} },
          ],
        }),
        new RegExp(`bundled package manifest ${invalidField} must be a non-empty string`),
      );
      await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('notice generation rejects a bundled package without a license file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-third-party-notices-'));
  try {
    const packageRoot = join(root, 'node_modules/unlicensed');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'unlicensed',
      version: '1.0.0',
      license: 'MIT',
    }));

    await assert.rejects(
      createBundledThirdPartyNotices({
        repositoryRoot: root,
        metafiles: [
          { inputs: { 'node_modules/unlicensed/index.js': {} } },
          { inputs: {} },
        ],
      }),
      /bundled package unlicensed@1\.0\.0 has no LICENSE file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed notice generation removes a stale output artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-third-party-notices-'));
  try {
    const packageRoot = join(root, 'node_modules/unlicensed');
    const outputPath = join(root, 'THIRD_PARTY_NOTICES.txt');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'unlicensed',
      version: '1.0.0',
      license: 'MIT',
    }));
    await writeFile(outputPath, 'stale notices');

    await assert.rejects(
      writeBundledThirdPartyNotices({
        repositoryRoot: root,
        outputPath,
        metafiles: [
          { inputs: { 'node_modules/unlicensed/index.js': {} } },
          { inputs: {} },
        ],
      }),
      /bundled package unlicensed@1\.0\.0 has no LICENSE file/,
    );
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('notice generation rejects a bundled package without declared license metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-third-party-notices-'));
  try {
    const packageRoot = join(root, 'node_modules/missing-license-field');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'missing-license-field',
      version: '1.0.0',
    }));
    await writeFile(join(packageRoot, 'LICENSE'), 'license text');

    await assert.rejects(
      createBundledThirdPartyNotices({
        repositoryRoot: root,
        metafiles: [
          { inputs: { 'node_modules/missing-license-field/index.js': {} } },
          { inputs: {} },
        ],
      }),
      /bundled package missing-license-field@1\.0\.0 has no declared license/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('notice generation rejects conflicting evidence for one package identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-third-party-notices-'));
  try {
    for (const [parent, text] of [['left', 'left license'], ['right', 'right license']]) {
      const packageRoot = join(root, `node_modules/${parent}/node_modules/shared`);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'shared',
        version: '1.0.0',
        license: 'MIT',
      }));
      await writeFile(join(packageRoot, 'LICENSE'), text);
    }

    await assert.rejects(
      createBundledThirdPartyNotices({
        repositoryRoot: root,
        metafiles: [
          {
            inputs: {
              'node_modules/left/node_modules/shared/index.js': {},
              'node_modules/right/node_modules/shared/index.js': {},
            },
          },
          { inputs: {} },
        ],
      }),
      /conflicting license evidence for bundled package shared@1\.0\.0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function bundledPackagesFrom(metafiles) {
  const roots = new Set();
  for (const metafile of metafiles) {
    for (const inputPath of Object.keys(metafile.inputs)) {
      const segments = inputPath.replaceAll('\\', '/').split('/');
      const nodeModulesIndex = segments.lastIndexOf('node_modules');
      if (nodeModulesIndex < 0 || !segments[nodeModulesIndex + 1]) continue;
      const packageEnd = segments[nodeModulesIndex + 1].startsWith('@')
        ? nodeModulesIndex + 3
        : nodeModulesIndex + 2;
      roots.add(resolve(repositoryRoot, segments.slice(0, packageEnd).join('/')));
    }
  }

  const packages = new Map();
  for (const packageRoot of roots) {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const licenseFiles = (await readdir(packageRoot))
      .filter((entry) => /^licen[cs]e(?:$|[._-])/i.test(entry))
      .sort();
    const bundledPackage = {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      licenseTexts: await Promise.all(
        licenseFiles.map((entry) => readFile(join(packageRoot, entry), 'utf8')),
      ),
    };
    const key = `${manifest.name}@${manifest.version}`;
    const existing = packages.get(key);
    if (existing) assert.deepEqual(existing, bundledPackage);
    else packages.set(key, bundledPackage);
  }
  return [...packages.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ));
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
