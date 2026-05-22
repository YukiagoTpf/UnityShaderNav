import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanBlocks } from '../../../src/parser/shaderlab/blockScanner';
import { scanStructure } from '../../../src/parser/shaderlab/structureScanner';

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

describe('scanBlocks: nested braces inside HLSL', () => {
  it('does not get confused by braces in HLSL body', () => {
    const result = scanBlocks(fixture('nested-braces.shader'));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].unterminated).toBe(false);
  });
});

describe('scanBlocks: unterminated block', () => {
  it('flags unterminated=true and extends endLine to EOF', () => {
    const text = fixture('unterminated-block.shader');
    const lines = text.split(/\r?\n/);
    const result = scanBlocks(text);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].unterminated).toBe(true);
    expect(result.blocks[0].endLine).toBe(lines.length - 1);
  });
});

describe('scan integration: blocks fall inside their owning Pass', () => {
  it('every HLSLPROGRAM block sits inside some Pass node', () => {
    const text = fixture('multi-pass.shader');
    const blocks = scanBlocks(text).blocks;
    const structure = scanStructure(text);
    const passes = structure.shaders[0].children[0].children;

    for (const block of blocks) {
      const owner = passes.find(
        (p) => p.headerLine <= block.startLine && block.endLine <= p.closeLine,
      );
      expect(owner, `block at line ${block.startLine} should be inside a Pass`).toBeDefined();
    }
  });
});

describe('scanBlocks: directive with same-line block comment (P2#1)', () => {
  it('recognizes HLSLPROGRAM and ENDHLSL when followed by /* */', () => {
    const result = scanBlocks(fixture('directive-block-comment.shader'));
    expect(result.blocks).toHaveLength(1);
    const [b] = result.blocks;
    expect(b.kind).toBe('HLSLPROGRAM');
    expect(b.unterminated).toBe(false);
    expect(b.startLine).toBe(3);
    expect(b.endLine).toBe(5);
  });
});
