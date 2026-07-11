import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ensureParserReady, parseHlsl } from '../../../src/parser/hlsl/parser';

describe('parseHlsl', () => {
  it('parses a trivial function and returns a Tree with non-null rootNode', async () => {
    const tree = await parseHlsl('float foo(float a) { return a; }');
    expect(tree.rootNode).toBeDefined();
    expect(tree.rootNode.hasError).toBe(false);
  });

  it('produces error nodes for invalid HLSL but does not throw', async () => {
    const tree = await parseHlsl('float foo( {');
    expect(tree.rootNode.hasError).toBe(true);
  });

  it('publishes the exact process-stable grammar fact loaded by the parser', async () => {
    const first = await ensureParserReady();
    const second = await ensureParserReady();

    expect(second).toBe(first);
    expect(Buffer.from(first.hlslGrammar.readBytes()))
      .toEqual(await readFile(first.hlslGrammar.path));
    const mutableCopy = first.hlslGrammar.readBytes();
    mutableCopy[0] ^= 0xff;
    expect(first.hlslGrammar.readBytes()[0]).not.toBe(mutableCopy[0]);
  });
});
