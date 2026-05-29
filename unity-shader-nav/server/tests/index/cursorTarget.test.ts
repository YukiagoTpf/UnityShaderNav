import { describe, it, expect } from 'vitest';
import { cursorTargetAt, type CursorTargetOptions } from '../../src/index/cursorTarget';

interface Case {
  name: string;
  text: string;
  position: { line: number; character: number };
  options?: CursorTargetOptions;
  assert: (target: ReturnType<typeof cursorTargetAt>) => void;
}

const cases: Case[] = [
  {
    name: 'include path: cursor inside the quoted path -> include',
    text: '#include "Common.hlsl"',
    position: { line: 0, character: 12 },
    assert: (target) => {
      expect(target.kind).toBe('include');
      if (target.kind === 'include') {
        expect(target.include.path).toBe('Common.hlsl');
      }
    },
  },
  {
    name: 'include line: cursor on the #include keyword (not the path) -> not include',
    text: '#include "Common.hlsl"',
    position: { line: 0, character: 3 },
    assert: (target) => {
      expect(target.kind).not.toBe('include');
      // The keyword char sits inside the "include" identifier.
      expect(target.kind).toBe('symbol');
      if (target.kind === 'symbol') {
        expect(target.word.text).toBe('include');
      }
    },
  },
  {
    name: 'include path with detectIncludes:false: path token resolves as symbol, not include',
    text: '#include "Common.hlsl"',
    position: { line: 0, character: 12 },
    options: { detectIncludes: false },
    assert: (target) => {
      expect(target.kind).not.toBe('include');
      expect(target.kind).toBe('symbol');
      if (target.kind === 'symbol') {
        expect(target.word.text).toBe('Common');
      }
    },
  },
  {
    name: '#include inside a block comment: scanIncludes strips comments -> not include',
    text: '/* #include "Common.hlsl" */',
    position: { line: 0, character: 15 },
    assert: (target) => {
      expect(target.kind).not.toBe('include');
    },
  },
  {
    name: 'member access: cursor inside member -> member with receiver+member text',
    text: 'float3 c = lights[i].color;',
    position: { line: 0, character: 23 },
    assert: (target) => {
      expect(target.kind).toBe('member');
      if (target.kind === 'member') {
        expect(target.receiver.text).toBe('lights[i]');
        expect(target.member.text).toBe('color');
      }
    },
  },
  {
    name: 'plain identifier -> symbol',
    text: 'float myVar = 0;',
    position: { line: 0, character: 8 },
    assert: (target) => {
      expect(target.kind).toBe('symbol');
      if (target.kind === 'symbol') {
        expect(target.word.text).toBe('myVar');
      }
    },
  },
  {
    name: 'cursor on whitespace -> none',
    text: 'float myVar = 0;',
    position: { line: 0, character: 5 },
    assert: (target) => {
      expect(target.kind).toBe('none');
    },
  },
];

describe('cursorTargetAt', () => {
  for (const c of cases) {
    it(c.name, () => {
      c.assert(cursorTargetAt(c.text, c.position, c.options));
    });
  }
});
