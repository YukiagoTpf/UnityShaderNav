import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanBlocks } from '../../../../server/src/parser/shaderlab/blockScanner';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('scanBlocks: single-pass', () => {
  it('finds exactly one HLSLPROGRAM block', () => {
    const text = fixture('single-pass.shader');
    const result = scanBlocks(text);

    expect(result.blocks).toHaveLength(1);
    const [b] = result.blocks;
    expect(b.kind).toBe('HLSLPROGRAM');
    expect(b.startLine).toBe(3);
    expect(b.endLine).toBe(6);
    expect(b.contentStartLine).toBe(4);
    expect(b.contentEndLine).toBe(5);
    expect(b.unterminated).toBe(false);
  });
});

describe('scanBlocks: multi-pass', () => {
  it('finds 2 HLSLPROGRAM blocks', () => {
    const result = scanBlocks(fixture('multi-pass.shader'));
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].kind).toBe('HLSLPROGRAM');
    expect(result.blocks[1].kind).toBe('HLSLPROGRAM');
    expect(result.blocks[0].startLine).toBeLessThan(result.blocks[1].startLine);
  });
});

describe('scanBlocks: HLSLINCLUDE + Pass', () => {
  it('emits HLSLINCLUDE first then HLSLPROGRAM', () => {
    const result = scanBlocks(fixture('hlslinclude-with-passes.shader'));
    expect(result.blocks.map((b) => b.kind)).toEqual(['HLSLINCLUDE', 'HLSLPROGRAM']);
    expect(result.blocks.every((b) => !b.unterminated)).toBe(true);
  });
});

describe('scanBlocks: CG legacy', () => {
  it('matches CGPROGRAM with ENDCG', () => {
    const result = scanBlocks(fixture('cg-legacy.shader'));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].kind).toBe('CGPROGRAM');
    expect(result.blocks[0].unterminated).toBe(false);
  });
});

describe('scanBlocks: comments do not trigger', () => {
  it('ignores HLSLPROGRAM/ENDHLSL inside line comments', () => {
    const result = scanBlocks(fixture('mixed-comments.shader'));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].unterminated).toBe(false);
  });
});
