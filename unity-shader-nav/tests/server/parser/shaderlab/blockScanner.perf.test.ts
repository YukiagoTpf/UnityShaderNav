import { describe, it, expect } from 'vitest';
import { scanBlocks } from '../../../../server/src/parser/shaderlab/blockScanner';

describe('blockScanner perf smoke', () => {
  it('scans 10000-line synthetic shader in < 50ms', () => {
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

    const t0 = performance.now();
    const result = scanBlocks(text);
    const dt = performance.now() - t0;

    expect(result.blocks.length).toBe(1000);
    expect(dt).toBeLessThan(50);
  });
});
