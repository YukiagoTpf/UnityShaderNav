import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexFile } from '../../../src/parser/hlsl/fileIndexer';

describe('fileIndexer: pure .hlsl', () => {
  it('treats whole file as one HLSL block', async () => {
    const text = `float4 add(float4 a, float4 b) { return a + b; }`;
    const idx = await indexFile('file:///t/x.hlsl', text);
    expect(idx.symbols.find((s) => s.name === 'add')).toBeDefined();
  });

  it('records #include directives as references with context=include', async () => {
    const text = `#include "Common.hlsl"\nfloat4 x() { return 0; }`;
    const idx = await indexFile('file:///t/a.hlsl', text);
    const includeRef = idx.references.find((r) => r.context === 'include');

    expect(includeRef?.name).toBe('Common.hlsl');
  });
});

describe('fileIndexer: .shader multi-pass', () => {
  it('flattens symbols from all HLSL blocks into one file index', async () => {
    const text = readFileSync(
      join(__dirname, '../shaderlab/fixtures/multi-pass.shader'),
      'utf8',
    );
    const idx = await indexFile('file:///t/x.shader', text);
    const verts = idx.symbols.filter((s) => s.kind === 'function' && s.name === 'vert');
    // multi-pass fixture has 2 `void vert() {}` definitions
    expect(verts).toHaveLength(2);
    // 行号必须落在原 .shader 文件的对应行（不应该是 0/1，应该是 HLSLPROGRAM 后一两行）
    expect(verts[0].location.range.start.line).toBeGreaterThan(3);
    expect(verts[1].location.range.start.line).toBeGreaterThan(verts[0].location.range.start.line);
  });
});
