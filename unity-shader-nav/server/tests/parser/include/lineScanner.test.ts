import { describe, expect, it } from 'vitest';
import { scanIncludes } from '../../../src/parser/include/lineScanner';

describe('scanIncludes', () => {
  it('extracts #include directives with quoted path and range', () => {
    const text = [
      '// banner',
      '#include "Common.hlsl"',
      '  #include   "Inner/Lighting.hlsl"',
      'float4 main() { return 0; }',
    ].join('\n');

    const result = scanIncludes(text);

    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('Common.hlsl');
    expect(result[0].pathRange.start.line).toBe(1);
    const lineText = text.split('\n')[1];
    expect(lineText.slice(
      result[0].pathRange.start.character,
      result[0].pathRange.end.character,
    )).toBe('Common.hlsl');
  });

  it('ignores include in line comment', () => {
    const text = '// #include "fake.hlsl"\nvoid f() {}';
    expect(scanIncludes(text)).toHaveLength(0);
  });
});
