import { describe, it, expect } from 'vitest';
import { IndexStore } from '../../src/index';
import { indexFile } from '../../src/parser/hlsl';
import { wordAt } from '../../src/index/wordAt';
import { resolveDefinition } from '../../src/index/symbolResolver';

describe('e2e (in-process): F12 inside .hlsl', () => {
  it('jumps from call site to function declaration', async () => {
    const uri = 'file:///t/x.hlsl';
    const text = `
float4 add(float4 a, float4 b) { return a + b; }
float4 main() { return add(float4(0,0,0,1), float4(1,1,1,1)); }
`.trim();

    const store = new IndexStore();
    store.set(uri, await indexFile(uri, text));

    const pos = { line: 1, character: 24 };
    const word = wordAt(text, pos);
    expect(word?.text).toBe('add');

    const links = resolveDefinition(store.get(uri)!, word!.text, pos);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].targetUri).toBe(uri);
    expect(links[0].targetRange.start.line).toBe(0);
  });
});
