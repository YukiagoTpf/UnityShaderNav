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

describe('scanStructure: inline Pass { Name "X" } (P1#2)', () => {
  it('extracts name from same line as Pass {', () => {
    const result = scanStructure(fixture('inline-pass-name.shader'));
    const passes = result.shaders[0].children[0].children;
    expect(passes).toHaveLength(2);
    expect(passes[0].name).toBe('Inline');
    expect(passes[1].name).toBe('Multiline');
  });
});

describe('scanStructure: explicit ranges (P2#2)', () => {
  it('records headerLine and closeLine for single-pass shader', () => {
    const result = scanStructure(fixture('single-pass.shader'));
    const shader = result.shaders[0];
    expect(shader.headerLine).toBe(0);
    expect(shader.closeLine).toBe(9);
    const subshader = shader.children[0];
    expect(subshader.headerLine).toBe(1);
    expect(subshader.closeLine).toBe(8);
    const pass = subshader.children[0];
    expect(pass.headerLine).toBe(2);
    expect(pass.closeLine).toBe(7);
  });

  it('returns multiple SubShader siblings with correct ranges', () => {
    const result = scanStructure(fixture('multi-subshader.shader'));
    const shader = result.shaders[0];
    expect(shader.headerLine).toBe(0);
    expect(shader.closeLine).toBe(16);

    const subs = shader.children;
    expect(subs).toHaveLength(2);
    expect(subs[0].kind).toBe('subshader');
    expect(subs[1].kind).toBe('subshader');
    expect(subs[0].headerLine).toBe(1);
    expect(subs[0].closeLine).toBe(8);
    expect(subs[1].headerLine).toBe(9);
    expect(subs[1].closeLine).toBe(15);

    // Each SubShader has exactly one Pass.
    expect(subs[0].children).toHaveLength(1);
    expect(subs[1].children).toHaveLength(1);
  });

  it('still produces a structurally-complete tree when HLSL block is unterminated', () => {
    // unterminated-block.shader leaves HLSLPROGRAM without ENDHLSL, but
    // ShaderLab braces still balance — structure tree closes normally.
    const result = scanStructure(fixture('unterminated-block.shader'));
    const shader = result.shaders[0];
    const pass = shader.children[0].children[0];
    expect(shader.closeLine).toBe(8);
    expect(pass.closeLine).toBe(6);
  });

  it('ignores block comments between SubShader and Pass tokens', () => {
    const text = `Shader "X" {
  SubShader {
    /* between */
    Pass {
    }
  }
}`;
    const result = scanStructure(text);
    const pass = result.shaders[0].children[0].children[0];
    expect(pass.kind).toBe('pass');
    expect(pass.headerLine).toBe(3);
  });
});
