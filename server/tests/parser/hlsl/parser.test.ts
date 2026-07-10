import { describe, it, expect } from 'vitest';
import { parseHlsl } from '../../../src/parser/hlsl/parser';

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
});
