import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanDefines } from '../../../src/parser/preproc/scanDefines';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('scanDefines', () => {
  it('captures simple #define names with line/range', () => {
    const text = fixture('defines.hlsl');
    const out = scanDefines(text);

    expect(out.map((d) => d.name).sort()).toEqual([
      'EMPTY',
      'MAX_LIGHTS',
      'PRESSED_MULTI_SPACES',
      'SAMPLE_TEXTURE2D',
    ]);

    const max = out.find((d) => d.name === 'MAX_LIGHTS')!;
    expect(max.line).toBe(0);
    const lineText = text.split('\n')[0];
    expect(lineText.slice(max.nameRange.start.character, max.nameRange.end.character)).toBe(
      'MAX_LIGHTS',
    );
  });

  it('ignores commented-out defines', () => {
    const text = fixture('defines.hlsl');
    const out = scanDefines(text);

    expect(out.find((d) => d.name === 'COMMENTED_OUT')).toBeUndefined();
  });
});
