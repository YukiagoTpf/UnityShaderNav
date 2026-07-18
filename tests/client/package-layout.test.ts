import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

interface RuntimeArtifactGraph {
  readonly freshnessChecks: ReadonlyArray<{
    readonly output: string;
    readonly inputs: readonly string[];
  }>;
  readonly parserRuntimeLayouts: ReadonlyArray<readonly [string, string]>;
  readonly requiredOutputFiles: readonly string[];
  readonly requiredVsixEntries: readonly string[];
}

const runtimeArtifacts = require(path.resolve(
  __dirname,
  '../../../scripts/runtime-artifacts.cjs',
)) as {
  createRuntimeArtifactGraph(root: string): RuntimeArtifactGraph;
};
const ARTIFACT_GRAPH = runtimeArtifacts.createRuntimeArtifactGraph(monorepoRoot());
const REQUIRED_VSIX_ENTRIES = ARTIFACT_GRAPH.requiredVsixEntries;

interface ParserRuntimeAssets {
  readonly layout: 'source' | 'tsc-out' | 'copied-server' | 'bundled-server';
  readonly runtimeRoot: string;
  readonly hlslGrammar: {
    readonly path: string;
    readonly contentHash: string;
    readBytes(): Uint8Array;
  };
}

function monorepoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function parseRuntimeAssetInChild(
  runtimeAssetsModulePath: string,
  moduleFile: string,
  serverEntry: string,
): ReturnType<typeof spawnSync> {
  const script = `
const { createRequire } = require('node:module');
const [runtimeAssetsModulePath, moduleFile, serverEntry] = process.argv.slice(1);
const { resolveParserRuntimeAssets } = require(runtimeAssetsModulePath);
const runtimeAssets = resolveParserRuntimeAssets(moduleFile);
const requireFromServer = createRequire(serverEntry);
(async () => {
  const TS = requireFromServer('web-tree-sitter');
  await TS.init();
  const language = await TS.Language.load(runtimeAssets.hlslGrammar.readBytes());
  const parser = new TS();
  parser.setLanguage(language);
  const tree = parser.parse('float exactRuntimeAsset() { return 1; }');
  if (tree.rootNode.type !== 'translation_unit' || tree.rootNode.hasError) process.exit(2);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  return spawnSync(
    process.execPath,
    ['-e', script, runtimeAssetsModulePath, moduleFile, serverEntry],
    { encoding: 'utf8', timeout: 60000 },
  );
}

suite('packaged server layout', () => {
  test('copied server parser can load the vendored HLSL wasm grammar', async () => {
    const parserPath = path.resolve(monorepoRoot(), 'client/out/server/parser/hlsl/parser.js');
    const { parseHlsl } = require(parserPath) as {
      parseHlsl(text: string): Promise<{ rootNode: { type: string; hasError: boolean } }>;
    };

    const tree = await parseHlsl('float f() { return 1; }');
    assert.strictEqual(tree.rootNode.type, 'translation_unit');
    assert.strictEqual(tree.rootNode.hasError, false);
  });

  test('every layout loads its exact grammar and only bundled release enables persistence', async () => {
    const root = monorepoRoot();
    const serverRoot = path.resolve(root, 'client/out/server');
    const serverEntry = path.join(serverRoot, 'server.js');
    const runtimeAssetsModulePath = path.join(serverRoot, 'parser/runtimeAssets.js');
    const releaseVersionModulePath = path.join(serverRoot, 'cache/releaseVersion.js');
    const { resolveParserRuntimeAssets } = require(runtimeAssetsModulePath) as {
      resolveParserRuntimeAssets(moduleFile: string): ParserRuntimeAssets;
    };
    const { releaseVersionForModule } = require(releaseVersionModulePath) as {
      releaseVersionForModule(
        moduleFile: string,
        runtimeAssets: ParserRuntimeAssets,
      ): string | undefined;
    };
    const extensionVersion = (JSON.parse(
      fs.readFileSync(path.join(root, 'client/package.json'), 'utf8'),
    ) as { version: string }).version;
    const layouts = ARTIFACT_GRAPH.parserRuntimeLayouts.map(([layout, moduleFile]) => (
      [layout, path.join(root, moduleFile)] as const
    ));

    for (const [layout, moduleFile] of layouts) {
      const assets = resolveParserRuntimeAssets(moduleFile);
      assert.strictEqual(assets.layout, layout);
      assert.strictEqual(
        releaseVersionForModule(moduleFile, assets),
        layout === 'bundled-server' ? extensionVersion : undefined,
      );
      const parseResult = parseRuntimeAssetInChild(
        runtimeAssetsModulePath,
        moduleFile,
        serverEntry,
      );
      assert.strictEqual(
        parseResult.status,
        0,
        parseResult.error?.message || String(parseResult.stderr || parseResult.stdout),
      );
    }
  });

  test('bundled server entry does not depend on private workspace packages at runtime', () => {
    const root = monorepoRoot();
    const serverEntry = path.resolve(root, 'client/out/server/server.js');
    const bundle = fs.readFileSync(serverEntry, 'utf8');

    assert.doesNotMatch(bundle, /require\(["']@unity-shader-nav\/shared["']\)/);
    assert.doesNotMatch(bundle, /require\(["']vscode-languageserver\/node["']\)/);
    assert.doesNotMatch(bundle, /require\(["']vscode-languageserver-textdocument["']\)/);

    const clientPackage = JSON.parse(
      fs.readFileSync(path.resolve(root, 'client/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    assert.ok(
      clientPackage.dependencies?.['web-tree-sitter'],
      'web-tree-sitter must be a client runtime dependency because parser.ts loads it dynamically',
    );

    const fromServerEntry = createRequire(serverEntry);
    assert.ok(fromServerEntry.resolve('web-tree-sitter').includes('web-tree-sitter'));
  });

  test('VSIX-like extension root can start packaged parser without monorepo node_modules', async () => {
    const root = monorepoRoot();
    const sourceOutRoot = path.resolve(root, 'client/out');
    // realpathSync the temp root: on macOS os.tmpdir() can return a symlinked
    // path (/tmp -> /private/tmp), but createRequire(...).resolve() below returns
    // the realpath, so the `startsWith(packagedServerRoot)` check would fail
    // unless both sides are realpath-normalized.
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-vsix-')));
    const extensionRoot = path.join(tempRoot, 'extension');
    const packagedOutRoot = path.join(extensionRoot, 'out');
    const packagedServerRoot = path.join(packagedOutRoot, 'server');
    try {
      fs.cpSync(sourceOutRoot, packagedOutRoot, { recursive: true });
      const serverEntry = path.join(packagedServerRoot, 'server.js');
      const resolved = createRequire(serverEntry).resolve('web-tree-sitter');

      assert.ok(
        resolved.startsWith(packagedServerRoot),
        `expected web-tree-sitter to resolve inside packaged server root, got ${resolved}`,
      );

      const parserPath = path.join(packagedServerRoot, 'parser/hlsl/parser.js');
      const { parseHlsl } = require(parserPath) as {
        parseHlsl(text: string): Promise<{ rootNode: { type: string; hasError: boolean } }>;
      };
      const tree = await parseHlsl('float f() { return 1; }');
      assert.strictEqual(tree.rootNode.type, 'translation_unit');
      assert.strictEqual(tree.rootNode.hasError, false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('packaging guard rejects stale server output', () => {
    const root = monorepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-stale-'));
    try {
      const oldTime = new Date('2024-01-01T00:00:01.000Z');
      const newTime = new Date('2024-01-01T00:00:01.500Z');
      const tempGraph = runtimeArtifacts.createRuntimeArtifactGraph(tempRoot);
      const files = [...new Set(tempGraph.freshnessChecks.flatMap((check) => (
        [check.output, ...check.inputs]
      )))];

      for (const file of files) {
        const absolute = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, file);
        fs.utimesSync(absolute, oldTime, oldTime);
      }
      const serverInput = path.join(tempRoot, 'server/src');
      fs.rmSync(serverInput, { force: true });
      fs.mkdirSync(serverInput, { recursive: true });
      fs.writeFileSync(path.join(serverInput, 'server.ts'), 'new server input');
      fs.utimesSync(path.join(serverInput, 'server.ts'), newTime, newTime);

      const result = spawnSync(
        process.execPath,
        [path.resolve(root, 'scripts/package-vsix.mjs'), '--check-output', '--monorepo-root', tempRoot],
        { encoding: 'utf8' },
      );

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /client[\\/]out[\\/]server[\\/]server\.js is stale/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('current-run packaging removes the old VSIX before a fallible build', () => {
    const root = monorepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-package-run-'));
    try {
      const clientRoot = path.join(tempRoot, 'client');
      const vsixPath = path.join(clientRoot, 'fixture-extension-1.2.3.vsix');
      fs.mkdirSync(clientRoot, { recursive: true });
      fs.writeFileSync(
        path.join(clientRoot, 'package.json'),
        JSON.stringify({ name: 'fixture-extension', version: '1.2.3' }),
      );
      fs.writeFileSync(
        path.join(tempRoot, 'package.json'),
        JSON.stringify({
          private: true,
          scripts: {
            clean: 'node deliberately-missing-clean-script.js',
            build: 'node deliberately-missing-build-script.js',
          },
        }),
      );
      fs.writeFileSync(vsixPath, 'stale artifact');

      const result = spawnSync(
        process.execPath,
        [
          path.resolve(root, 'scripts/package-vsix.mjs'),
          '--build-and-verify',
          '--monorepo-root',
          tempRoot,
        ],
        { encoding: 'utf8' },
      );

      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(fs.existsSync(vsixPath), false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('VSIX verifier rejects generated TypeScript build cache entries', () => {
    const root = monorepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-vsix-check-'));
    try {
      const vsixPath = path.join(tempRoot, 'extension.vsix');
      fs.writeFileSync(vsixPath, zipWithCentralDirectoryEntries([
        ...REQUIRED_VSIX_ENTRIES,
        'extension/tsconfig.tsbuildinfo',
      ]));

      const result = spawnSync(
        process.execPath,
        [path.resolve(root, 'scripts/package-vsix.mjs'), '--verify-vsix', vsixPath],
        { encoding: 'utf8' },
      );

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /VSIX must not include generated file extension\/tsconfig\.tsbuildinfo/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('VSIX verifier rejects duplicate central-directory entries', () => {
    const root = monorepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-vsix-duplicate-'));
    try {
      const duplicate = REQUIRED_VSIX_ENTRIES[0];
      const vsixPath = path.join(tempRoot, 'extension.vsix');
      fs.writeFileSync(vsixPath, zipWithCentralDirectoryEntries([
        ...REQUIRED_VSIX_ENTRIES,
        duplicate,
      ]));

      const result = spawnSync(
        process.execPath,
        [path.resolve(root, 'scripts/package-vsix.mjs'), '--verify-vsix', vsixPath],
        { encoding: 'utf8' },
      );

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`duplicate entry ${duplicate}`));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  for (const requiredEntry of REQUIRED_VSIX_ENTRIES) {
    test(`VSIX verifier requires ${requiredEntry}`, () => {
      const root = monorepoRoot();
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-vsix-required-'));
      try {
        const vsixPath = path.join(tempRoot, 'extension.vsix');
        fs.writeFileSync(
          vsixPath,
          zipWithCentralDirectoryEntries(
            REQUIRED_VSIX_ENTRIES.filter((entry) => entry !== requiredEntry),
          ),
        );

        const result = spawnSync(
          process.execPath,
          [path.resolve(root, 'scripts/package-vsix.mjs'), '--verify-vsix', vsixPath],
          { encoding: 'utf8' },
        );

        assert.notStrictEqual(result.status, 0);
        assert.strictEqual(
          result.stderr.trim(),
          `VSIX is missing required file ${requiredEntry}`,
        );
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }

  test('direct VSCE package from client includes the extension documentation', function () {
    this.timeout(60000);

    const root = monorepoRoot();
    const clientRoot = path.resolve(root, 'client');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-direct-vsce-'));
    const vsixPath = path.join(tempRoot, 'direct.vsix');
    try {
      const npx = npxInvocation();
      const packageResult = spawnSync(
        npx.command,
        [...npx.argsPrefix, '--no-install', 'vsce', 'package', '--no-dependencies', '--no-yarn', '--out', vsixPath],
        { cwd: clientRoot, encoding: 'utf8' },
      );

      assert.strictEqual(
        packageResult.status,
        0,
        packageResult.error?.message || packageResult.stderr || packageResult.stdout,
      );

      const verifyResult = spawnSync(
        process.execPath,
        [path.resolve(root, 'scripts/package-vsix.mjs'), '--verify-vsix', vsixPath],
        { encoding: 'utf8' },
      );

      assert.strictEqual(verifyResult.status, 0, verifyResult.stderr);
    } finally {
      fs.rmSync(path.resolve(clientRoot, 'README.md'), { force: true });
      fs.rmSync(path.resolve(clientRoot, 'CHANGELOG.md'), { force: true });
      fs.rmSync(path.resolve(clientRoot, 'LICENSE'), { force: true });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

suite('runtime watch workflow', () => {
  test('root scripts expose the runtime watcher', () => {
    const root = monorepoRoot();
    const rootPackage = JSON.parse(
      fs.readFileSync(path.resolve(root, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const scripts = rootPackage.scripts ?? {};

    assert.strictEqual(scripts.watch, 'node scripts/watch-runtime.mjs');
    assert.strictEqual(scripts['dev:watch'], 'node scripts/watch-runtime.mjs');
    assert.strictEqual(scripts['watch:typecheck'], 'node scripts/watch-typecheck.mjs');
  });

  test('one-shot runtime build produces the extension development host layout', function () {
    this.timeout(120000);

    const root = monorepoRoot();
    const result = spawnSync(
      process.execPath,
      [path.resolve(root, 'scripts/watch-runtime.mjs'), '--once'],
      { cwd: root, encoding: 'utf8', timeout: 60000 },
    );

    assert.strictEqual(
      result.status,
      0,
      result.error?.message || result.stderr || result.stdout,
    );

    for (const relative of ARTIFACT_GRAPH.requiredOutputFiles) {
      assert.ok(
        fs.existsSync(path.resolve(root, relative)),
        `expected runtime layout file ${relative} to exist after --once build`,
      );
    }
  });
});

suite('verification command contract', () => {
  test('fast verification checks workspace and public knowledge contracts first', () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.resolve(monorepoRoot(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const scripts = rootPackage.scripts ?? {};

    assert.strictEqual(
      scripts['check:workspace-lock'],
      'node --test scripts/check-workspace-lock.test.mjs && node scripts/check-workspace-lock.mjs',
    );
    assert.strictEqual(
      scripts['check:knowledge'],
      'node --test scripts/check-public-knowledge.test.mjs && node scripts/check-public-knowledge.mjs',
    );
    assert.match(
      scripts['check:fast'] ?? '',
      /^npm run check:workspace-lock && npm run check:knowledge && /,
    );
    assert.strictEqual(
      scripts['grammar:rebuild'],
      'node scripts/rebuild-tree-sitter-hlsl.mjs',
    );
    assert.strictEqual(scripts['bench:index-cache'], 'node scripts/benchmark-index-cache.mjs');
    assert.strictEqual(
      scripts['bench:document-analysis'],
      'node scripts/benchmark-document-analysis.mjs',
    );
    assert.strictEqual(scripts['bench:issue3'], undefined);
  });

  test('index-cache benchmark proves a real three-file cold/warm restore', function () {
    this.timeout(60000);
    const root = monorepoRoot();
    const result = spawnSync(
      process.execPath,
      [path.resolve(root, 'scripts/benchmark-index-cache.mjs'), '--files', '3'],
      { cwd: root, encoding: 'utf8', timeout: 60000 },
    );

    assert.strictEqual(
      result.status,
      0,
      result.error?.message || result.stderr || result.stdout,
    );
    const report = JSON.parse(result.stdout) as {
      files?: number;
      cachePath?: string;
      cacheBytes?: number;
      warmRestored?: boolean;
      symbolAvailable?: boolean;
    };
    assert.strictEqual(report.files, 3);
    assert.match(
      report.cachePath ?? '',
      /[\\/]Library[\\/]UnityShaderNavCache[\\/]workspaces[\\/][0-9a-f]+[\\/]index\.json$/,
    );
    assert.ok((report.cacheBytes ?? 0) > 0);
    assert.strictEqual(report.warmRestored, true);
    assert.strictEqual(report.symbolAvailable, true);
  });

  test('package verification builds and inspects one current-run VSIX', () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.resolve(monorepoRoot(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const scripts = rootPackage.scripts ?? {};

    assert.strictEqual(
      scripts['package:vsix'],
      'node scripts/package-vsix.mjs --build-and-verify',
    );
    assert.strictEqual(
      scripts['test:package'],
      'npm run package:vsix && npm run compile:tests && npm run test:package-layout',
    );
    assert.strictEqual(
      scripts['test:integration'],
      'npm run test:package && npm run test:electron:prepared',
    );
    assert.strictEqual(
      scripts['test:electron'],
      'npm run test:package && npm run test:electron:prepared',
    );
  });
});

function zipWithCentralDirectoryEntries(entries: string[]): Buffer {
  const records = entries.map((entry) => {
    const name = Buffer.from(entry, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(name.length, 28);
    return Buffer.concat([header, name]);
  });
  const centralDirectory = Buffer.concat(records);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, endOfCentralDirectory]);
}

function npxInvocation(): { command: string; argsPrefix: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', 'npx.cmd'],
    };
  }
  return { command: 'npx', argsPrefix: [] };
}
