import { describe, expect, it } from 'vitest';
import { relative, resolve } from 'node:path';
import { walkFiles } from '../../src/workspace/walkFiles';

const root = resolve(__dirname, '../include/fixtures/projectA');

const rel = (file: string): string => relative(root, file).replace(/\\/g, '/');

describe('walkFiles', () => {
  it('finds shader source files', async () => {
    const files = await walkFiles(root, ['**/Library/**', '**/Temp/**']);
    const relativeFiles = files.map(rel);

    expect(relativeFiles).toContain('Assets/Shaders/Main.shader');
    expect(relativeFiles).toContain('Assets/Shaders/Common.hlsl');
  });

  it('excludes Packages from user walk', async () => {
    const files = await walkFiles(root, ['**/Library/**', 'Packages/**']);

    expect(files.map(rel).every((file) => !file.startsWith('Packages/'))).toBe(true);
  });
});
