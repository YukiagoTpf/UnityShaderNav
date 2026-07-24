import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

interface RuntimeArtifactFile {
  readonly path: string;
  readonly packagePath: string;
  readonly minBytes: number;
  readonly executable?: boolean;
}

interface RuntimeArtifactGraph {
  readonly runtimeFiles: ReadonlyArray<RuntimeArtifactFile>;
  readonly packageFiles: ReadonlyArray<RuntimeArtifactFile>;
  readonly parserRuntimeLayouts: ReadonlyArray<readonly [string, string]>;
  readonly requiredOutputFiles: readonly string[];
  readonly requiredPackagePaths: readonly string[];
}

const runtimeArtifacts = require(path.resolve(
  __dirname,
  '../../../scripts/runtime-artifacts.cjs',
)) as {
  createRuntimeArtifactGraph(root: string): RuntimeArtifactGraph;
};
const vsixFileModes = require(path.resolve(
  __dirname,
  '../../../scripts/vsix-file-modes.cjs',
)) as {
  readVsixFileModes(vsixPath: string): Promise<ReadonlyMap<string, number>>;
};
const ARTIFACT_GRAPH = runtimeArtifacts.createRuntimeArtifactGraph(monorepoRoot());
const vsce = require('@vscode/vsce') as {
  readonly PackageManager: { readonly None: number };
  listFiles(options: { cwd: string; packageManager: number }): Promise<string[]>;
};

interface ParserRuntimeAssets {
  readonly layout: 'source' | 'tsc-out' | 'copied-server' | 'bundled-server';
  readonly runtimeRoot: string;
  readonly hlslGrammar: {
    readonly path: string;
    readonly contentHash: string;
    readBytes(): Uint8Array;
  };
}

interface TreeSitterModule {
  new (): {
    setLanguage(language: unknown): void;
    parse(text: string): { rootNode: { type: string; hasError: boolean } };
  };
  init(): Promise<void>;
  readonly Language: {
    load(bytes: Uint8Array): Promise<unknown>;
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

  test('VSIX-like runtime payload loads the grammar without loose modules or monorepo node_modules', async () => {
    const root = monorepoRoot();
    // realpathSync the temp root: on macOS os.tmpdir() can return a symlinked
    // path (/tmp -> /private/tmp), but createRequire(...).resolve() below returns
    // the realpath, so the `startsWith(packagedServerRoot)` check would fail
    // unless both sides are realpath-normalized.
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-vsix-')));
    const extensionRoot = path.join(tempRoot, 'extension');
    const packagedOutRoot = path.join(extensionRoot, 'out');
    const packagedServerRoot = path.join(packagedOutRoot, 'server');
    try {
      for (const file of ARTIFACT_GRAPH.runtimeFiles) {
        const target = path.join(extensionRoot, file.packagePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, file.path), target);
      }
      const serverEntry = path.join(packagedServerRoot, 'server.js');
      const requireFromServer = createRequire(serverEntry);
      const resolved = requireFromServer.resolve('web-tree-sitter');

      assert.ok(
        resolved.startsWith(packagedServerRoot),
        `expected web-tree-sitter to resolve inside packaged server root, got ${resolved}`,
      );
      assert.strictEqual(fs.existsSync(path.join(packagedOutRoot, 'client.js')), false);
      assert.strictEqual(fs.existsSync(path.join(packagedServerRoot, 'parser')), false);

      const TS = requireFromServer('web-tree-sitter') as TreeSitterModule;
      await TS.init();
      const language = await TS.Language.load(
        fs.readFileSync(path.join(packagedOutRoot, 'grammars/tree-sitter-hlsl.wasm')),
      );
      const parser = new TS();
      parser.setLanguage(language);
      const tree = parser.parse('float f() { return 1; }');
      assert.strictEqual(tree.rootNode.type, 'translation_unit');
      assert.strictEqual(tree.rootNode.hasError, false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('packaging guard rejects a truncated runtime output', () => {
    const root = monorepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-truncated-'));
    try {
      const tempGraph = runtimeArtifacts.createRuntimeArtifactGraph(tempRoot);
      for (const file of tempGraph.runtimeFiles) {
        writeSizedArtifact(tempRoot, file);
      }
      fs.writeFileSync(path.join(tempRoot, 'client/out/server/server.js'), 'truncated');

      const result = spawnSync(
        process.execPath,
        [path.resolve(root, 'scripts/package-vsix.mjs'), '--check-output', '--monorepo-root', tempRoot],
        { encoding: 'utf8' },
      );

      assert.notStrictEqual(result.status, 0);
      assert.match(
        result.stderr,
        /client\/out\/server\/server\.js is truncated: 9 bytes; expected at least 1024/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('direct VSCE packaging rejects a truncated language config and restores staging', function () {
    this.timeout(60000);
    const root = monorepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-direct-vsce-'));
    try {
      const tempGraph = runtimeArtifacts.createRuntimeArtifactGraph(tempRoot);
      const clientRoot = path.join(tempRoot, 'client');
      const originalReadme = 'original client readme';
      const stagedNames = new Set(['README.md', 'CHANGELOG.md', 'LICENSE']);

      for (const file of tempGraph.packageFiles) {
        if (stagedNames.has(file.packagePath)) continue;
        writeSizedArtifact(tempRoot, file);
      }
      const packageScript = path.resolve(root, 'scripts/package-vsix.mjs');
      const prepublish = [
        quoteShellArgument(process.execPath),
        quoteShellArgument(packageScript),
        '--prepare-extension-root',
        '--monorepo-root',
        quoteShellArgument(tempRoot),
      ].join(' ');
      fs.writeFileSync(
        path.join(clientRoot, 'package.json'),
        `${JSON.stringify({
          name: 'fixture-extension',
          version: '1.2.3',
          publisher: 'fixture',
          engines: { vscode: '^1.85.0' },
          scripts: { 'vscode:prepublish': prepublish },
        })}${' '.repeat(64)}`,
      );
      fs.writeFileSync(path.join(clientRoot, 'README.md'), originalReadme);
      fs.writeFileSync(path.join(clientRoot, 'language-configuration/hlsl.json'), '{}');
      for (const name of stagedNames) {
        fs.writeFileSync(path.join(tempRoot, name), 'x'.repeat(64));
      }

      const vsixPath = path.join(tempRoot, 'direct.vsix');
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, 'node_modules/@vscode/vsce/vsce'),
          'package',
          '--no-dependencies',
          '--no-yarn',
          '--out',
          vsixPath,
        ],
        { cwd: clientRoot, encoding: 'utf8', timeout: 60000 },
      );

      assert.notStrictEqual(result.status, 0);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /language-configuration\/hlsl\.json is truncated: 2 bytes; expected at least 32/,
      );
      assert.strictEqual(fs.readFileSync(path.join(clientRoot, 'README.md'), 'utf8'), originalReadme);
      assert.strictEqual(fs.existsSync(path.join(clientRoot, 'CHANGELOG.md')), false);
      assert.strictEqual(fs.existsSync(path.join(clientRoot, 'LICENSE')), false);
      assert.strictEqual(fs.existsSync(vsixPath), false);
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

  test('failed post-package verification rejects unsafe VSIX files and restores staging', () => {
    const root = monorepoRoot();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-package-fail-'));
    try {
      const tempGraph = runtimeArtifacts.createRuntimeArtifactGraph(tempRoot);
      const clientRoot = path.join(tempRoot, 'client');
      const originalReadme = 'original client readme';
      const version = '1.2.3';
      const vsixPath = path.join(clientRoot, `fixture-extension-${version}.vsix`);
      const unrelatedVsixPath = path.join(clientRoot, 'keep-this.vsix');
      const stagedNames = new Set(['README.md', 'CHANGELOG.md', 'LICENSE']);

      for (const file of tempGraph.packageFiles) {
        if (stagedNames.has(file.packagePath)) continue;
        writeSizedArtifact(tempRoot, file);
      }
      fs.writeFileSync(
        path.join(clientRoot, 'package.json'),
        `${JSON.stringify({
          name: 'fixture-extension',
          version,
          publisher: 'fixture',
          engines: { vscode: '^1.85.0' },
        })}${' '.repeat(64)}`,
      );
      fs.writeFileSync(path.join(clientRoot, 'README.md'), originalReadme);
      fs.writeFileSync(unrelatedVsixPath, 'unrelated artifact');
      for (const name of stagedNames) {
        fs.writeFileSync(path.join(tempRoot, name), 'x'.repeat(64));
      }

      const fakeBin = path.join(tempRoot, 'fake-bin');
      fs.mkdirSync(fakeBin);
      const fakeNpxScript = path.join(fakeBin, 'fake-npx.cjs');
      fs.writeFileSync(fakeNpxScript, [
        "const { writeFileSync } = require('node:fs');",
        'const args = process.argv.slice(2);',
        "const outIndex = args.indexOf('--out');",
        "if (outIndex < 0 || !args[outIndex + 1]) throw new Error('missing --out');",
        "writeFileSync(args[outIndex + 1], 'tiny');",
      ].join('\n'));
      if (process.platform === 'win32') {
        fs.writeFileSync(
          path.join(fakeBin, 'npx.cmd'),
          `@"${process.execPath}" "%~dp0fake-npx.cjs" %*\r\n`,
        );
      } else {
        const fakeNpx = path.join(fakeBin, 'npx');
        fs.writeFileSync(
          fakeNpx,
          `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeNpxScript)});\n`,
        );
        fs.chmodSync(fakeNpx, 0o755);
      }

      const runPackage = (extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(
        process.execPath,
        [path.resolve(root, 'scripts/package-vsix.mjs'), '--monorepo-root', tempRoot],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
            ...extraEnv,
          },
        },
      );
      const result = runPackage();

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /VSIX output is truncated: 4 bytes; expected at least 1024/);
      assert.strictEqual(fs.readFileSync(path.join(clientRoot, 'README.md'), 'utf8'), originalReadme);
      assert.strictEqual(fs.existsSync(path.join(clientRoot, 'CHANGELOG.md')), false);
      assert.strictEqual(fs.existsSync(path.join(clientRoot, 'LICENSE')), false);
      assert.strictEqual(fs.existsSync(vsixPath), false);
      assert.strictEqual(fs.readFileSync(unrelatedVsixPath, 'utf8'), 'unrelated artifact');

      if (process.platform !== 'win32') {
        const symlinkTarget = path.join(tempRoot, 'symlink-target.vsix');
        fs.writeFileSync(symlinkTarget, Buffer.alloc(2_048, 'v'));
        fs.writeFileSync(fakeNpxScript, [
          "const { symlinkSync } = require('node:fs');",
          'const args = process.argv.slice(2);',
          "const outIndex = args.indexOf('--out');",
          "if (outIndex < 0 || !args[outIndex + 1]) throw new Error('missing --out');",
          "symlinkSync(process.env.FAKE_VSIX_TARGET, args[outIndex + 1], 'file');",
        ].join('\n'));

        const symlinkResult = runPackage({ FAKE_VSIX_TARGET: symlinkTarget });

        assert.notStrictEqual(symlinkResult.status, 0);
        assert.match(symlinkResult.stderr, /VSIX output must be a regular file/);
        assert.strictEqual(fs.existsSync(vsixPath), false);
        assert.strictEqual(fs.statSync(symlinkTarget).size, 2_048);
        assert.strictEqual(
          fs.readFileSync(path.join(clientRoot, 'README.md'), 'utf8'),
          originalReadme,
        );
        assert.strictEqual(fs.readFileSync(unrelatedVsixPath, 'utf8'), 'unrelated artifact');
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('VSCE package plan is the exact 18-file graph payload with only three JavaScript files', async function () {
    this.timeout(60000);

    const root = monorepoRoot();
    const clientRoot = path.resolve(root, 'client');
    const stagedFiles = ['README.md', 'CHANGELOG.md', 'LICENSE'];
    const previousFiles = new Map<string, Buffer | undefined>();
    for (const name of stagedFiles) {
      const target = path.join(clientRoot, name);
      previousFiles.set(name, fs.existsSync(target) ? fs.readFileSync(target) : undefined);
    }
    try {
      const prepareResult = spawnSync(
        process.execPath,
        [path.resolve(root, 'scripts/package-vsix.mjs'), '--prepare-extension-root'],
        { encoding: 'utf8', timeout: 60000 },
      );
      assert.strictEqual(
        prepareResult.status,
        0,
        prepareResult.error?.message || prepareResult.stderr || prepareResult.stdout,
      );

      const plannedFiles = await vsce.listFiles({
        cwd: clientRoot,
        packageManager: vsce.PackageManager.None,
      });
      assert.strictEqual(plannedFiles.length, 18);
      assert.deepStrictEqual(
        [...plannedFiles].sort(),
        [...ARTIFACT_GRAPH.requiredPackagePaths].sort(),
      );
      assert.deepStrictEqual(
        plannedFiles.filter((packagePath) => packagePath.endsWith('.js')).sort(),
        [
          'out/extension.js',
          'out/server/server.js',
          'out/server/node_modules/web-tree-sitter/tree-sitter.js',
        ].sort(),
      );
    } finally {
      for (const [name, previous] of previousFiles) {
        const target = path.join(clientRoot, name);
        if (previous) fs.writeFileSync(target, previous);
        else fs.rmSync(target, { force: true });
      }
    }
  });

  test('current VSIX stores deterministic Unix modes for every regular file', async () => {
    const root = monorepoRoot();
    const clientPackage = JSON.parse(
      fs.readFileSync(path.join(root, 'client/package.json'), 'utf8'),
    ) as { name: string; version: string };
    const vsixPath = path.join(
      root,
      'client',
      `${clientPackage.name}-${clientPackage.version}.vsix`,
    );
    const modes = await vsixFileModes.readVsixFileModes(vsixPath);
    const executableEntry = 'extension/out/terminateProcess.sh';

    assert.strictEqual(modes.get(executableEntry), 0o100755);
    for (const [entry, mode] of modes) {
      if (entry.endsWith('/')) continue;
      assert.strictEqual(
        mode,
        entry === executableEntry ? 0o100755 : 0o100644,
        `unexpected Unix mode for ${entry}`,
      );
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
      'npm run package:vsix && npm run compile:tests && npm run test:client-unit && npm run test:package-layout',
    );
    assert.strictEqual(
      scripts['test:client-unit'],
      'mocha tests/out/client/visualLabPresentation.test.js tests/out/client/passExplanationPresentation.test.js tests/out/client/passExplanationController.test.js --ui tdd --timeout 60000',
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

function quoteShellArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function writeSizedArtifact(root: string, file: RuntimeArtifactFile): void {
  const absolute = path.join(root, file.path);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, Buffer.alloc(file.minBytes, 'x'));
  if (file.executable && process.platform !== 'win32') fs.chmodSync(absolute, 0o755);
}
