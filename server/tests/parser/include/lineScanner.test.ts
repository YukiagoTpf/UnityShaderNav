import { describe, expect, it } from 'vitest';
import { scanIncludes } from '../../../src/parser/include/lineScanner';

describe('scanIncludes', () => {
  it('extracts quoted, angle-bracket, and include_with_pragmas directives with ranges', () => {
    const text = [
      '// banner',
      '#include "Common.hlsl"',
      '  #include   <Inner/Lighting.hlsl>',
      '#include_with_pragmas "Pragmas.hlsl"',
      'float4 main() { return 0; }',
    ].join('\n');

    const result = scanIncludes(text);

    expect(result.map((directive) => directive.path)).toEqual([
      'Common.hlsl',
      'Inner/Lighting.hlsl',
      'Pragmas.hlsl',
    ]);
    expect(result[0].pathRange.start.line).toBe(1);
    for (const directive of result) {
      const lineText = text.split('\n')[directive.line];
      expect(lineText.slice(
        directive.pathRange.start.character,
        directive.pathRange.end.character,
      )).toBe(directive.path);
      expect(lineText.slice(
        directive.directiveRange.start.character,
        directive.directiveRange.end.character,
      )).toMatch(/^#\s*include(?:_with_pragmas)?$/);
    }
  });

  it('ignores include in line comment', () => {
    const text = '// #include "fake.hlsl"\nvoid f() {}';
    expect(scanIncludes(text)).toHaveLength(0);
  });

  it('keeps a // inside the include path (string-aware masking)', () => {
    // The path string is preserved, so the // inside it is not mistaken for a
    // line comment and the directive still resolves.
    const result = scanIncludes('#include "a//b.hlsl"');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('a//b.hlsl');
  });

  it('ignores include in multi-line block comment', () => {
    const text = [
      '#include "Real.hlsl"',
      '/*',
      '#include "Fake.hlsl"',
      '*/',
      '#include "AlsoReal.hlsl"',
    ].join('\n');

    expect(scanIncludes(text).map((directive) => directive.path)).toEqual([
      'Real.hlsl',
      'AlsoReal.hlsl',
    ]);
  });
});
