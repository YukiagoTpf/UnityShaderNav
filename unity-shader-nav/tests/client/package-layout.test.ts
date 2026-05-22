import * as assert from 'node:assert';
import * as path from 'node:path';

suite('packaged server layout', () => {
  test('copied server parser can load the vendored HLSL wasm grammar', async () => {
    const monorepoRoot = path.resolve(__dirname, '../../..');
    const parserPath = path.resolve(monorepoRoot, 'client/out/server/parser/hlsl/parser.js');
    const { parseHlsl } = require(parserPath) as {
      parseHlsl(text: string): Promise<{ rootNode: { type: string; hasError: boolean } }>;
    };

    const tree = await parseHlsl('float f() { return 1; }');
    assert.strictEqual(tree.rootNode.type, 'translation_unit');
    assert.strictEqual(tree.rootNode.hasError, false);
  });
});
