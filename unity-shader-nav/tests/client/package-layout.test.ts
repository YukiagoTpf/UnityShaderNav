import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

function monorepoRoot(): string {
  return path.resolve(__dirname, '../../..');
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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-vsix-'));
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
      const oldTime = new Date('2024-01-01T00:00:00Z');
      const newTime = new Date('2024-01-02T00:00:00Z');
      const files = [
        'client/out/extension.js',
        'client/out/server/server.js',
        'client/out/grammars/tree-sitter-hlsl.wasm',
        'client/out/server/node_modules/web-tree-sitter/tree-sitter.js',
        'client/out/server/node_modules/web-tree-sitter/tree-sitter.wasm',
        'client/src/extension.ts',
        'server/src/server.ts',
        'server/grammars/tree-sitter-hlsl.wasm',
        'node_modules/web-tree-sitter/tree-sitter.js',
        'node_modules/web-tree-sitter/tree-sitter.wasm',
      ];

      for (const file of files) {
        const absolute = path.join(tempRoot, file);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, file);
        fs.utimesSync(absolute, oldTime, oldTime);
      }
      fs.utimesSync(path.join(tempRoot, 'server/src/server.ts'), newTime, newTime);

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
});
