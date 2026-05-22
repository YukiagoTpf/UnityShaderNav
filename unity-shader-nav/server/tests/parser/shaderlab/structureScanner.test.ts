import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanStructure } from '../../../src/parser/shaderlab/structureScanner';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('scanStructure: single-pass', () => {
  it('returns Shader > SubShader > Pass tree with shader name', () => {
    const result = scanStructure(fixture('single-pass.shader'));
    expect(result.shaders).toHaveLength(1);
    const shader = result.shaders[0];
    expect(shader.kind).toBe('shader');
    expect(shader.name).toBe('Test/Single');
    expect(shader.children).toHaveLength(1);

    const subshader = shader.children[0];
    expect(subshader.kind).toBe('subshader');
    expect(subshader.children).toHaveLength(1);

    const pass = subshader.children[0];
    expect(pass.kind).toBe('pass');
  });
});

describe('scanStructure: multi-pass with names', () => {
  it('extracts Pass Name "X" tokens', () => {
    const result = scanStructure(fixture('multi-pass.shader'));
    const passes = result.shaders[0].children[0].children;
    expect(passes.map((p) => p.name)).toEqual(['ForwardLit', 'ShadowCaster']);
  });
});

describe('scanStructure: braces inside strings (P1#1)', () => {
  it('does not close pass/subshader/shader on `"}"` literal', () => {
    const result = scanStructure(fixture('strings-with-braces.shader'));
    expect(result.shaders).toHaveLength(1);
    const shader = result.shaders[0];
    const subshader = shader.children[0];
    const pass = subshader.children[0];

    expect(pass.closeLine).toBe(6);
    expect(subshader.closeLine).toBe(7);
    expect(shader.closeLine).toBe(8);
  });
});
