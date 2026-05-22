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
