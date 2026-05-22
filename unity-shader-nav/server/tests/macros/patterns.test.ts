import { describe, it, expect } from 'vitest';
import { parsePattern } from '../../src/macros/patterns';

describe('parsePattern', () => {
  it('parses a single-capture macro', () => {
    const p = parsePattern('TEXTURE2D($name)');
    expect(p.head).toBe('TEXTURE2D');
    expect(p.params.map((x) => x.kind)).toEqual(['capture']);
    expect(p.params[0].name).toBe('name');
  });

  it('parses a macro with placeholder + capture', () => {
    const p = parsePattern('UNITY_DEFINE_INSTANCED_PROP(_, $name)');
    expect(p.head).toBe('UNITY_DEFINE_INSTANCED_PROP');
    expect(p.params.map((x) => x.kind)).toEqual(['placeholder', 'capture']);
  });

  it('parses a #pragma reference pattern', () => {
    const p = parsePattern('#pragma vertex $func');
    expect(p.head).toBe('#pragma vertex');
    expect(p.params).toHaveLength(1);
    expect(p.params[0].kind).toBe('capture');
  });

  it('throws on malformed input', () => {
    expect(() => parsePattern('TEXTURE2D')).toThrow();
  });
});
