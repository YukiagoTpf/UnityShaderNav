import { describe, it, expect } from 'vitest';
import { scanBlocks } from '../../../src/parser/shaderlab/blockScanner';

describe('blockScanner large-input smoke', () => {
  it('scans a synthetic shader with 1000 passes', () => {
    const body = Array.from({ length: 1000 }, () =>
      [
        '    Pass {',
        '      HLSLPROGRAM',
        '      void f() {}',
        '      ENDHLSL',
        '    }',
      ].join('\n'),
    ).join('\n');
    const text = `Shader "Big" {\n  SubShader {\n${body}\n  }\n}`;

    const result = scanBlocks(text);

    expect(result.blocks.length).toBe(1000);
  });
});
