import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as os from 'node:os';

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

  test('VSIX-like server root can resolve web-tree-sitter without monorepo node_modules', () => {
    const root = monorepoRoot();
    const sourceServerRoot = path.resolve(root, 'client/out/server');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-shader-nav-vsix-'));
    const extensionRoot = path.join(tempRoot, 'extension');
    const packagedServerRoot = path.join(extensionRoot, 'out/server');
    try {
      fs.cpSync(sourceServerRoot, packagedServerRoot, { recursive: true });
      const serverEntry = path.join(packagedServerRoot, 'server.js');
      const resolved = createRequire(serverEntry).resolve('web-tree-sitter');

      assert.ok(
        resolved.startsWith(packagedServerRoot),
        `expected web-tree-sitter to resolve inside packaged server root, got ${resolved}`,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
