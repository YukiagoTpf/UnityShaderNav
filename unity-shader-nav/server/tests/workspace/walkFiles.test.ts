import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { join, relative, resolve } from 'node:path';
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

  it('returns deterministic sorted shader files while preserving excludes', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'usn-walk-sorted-'));
    try {
      await mkdir(join(tempRoot, 'Assets', 'B'), { recursive: true });
      await mkdir(join(tempRoot, 'Assets', 'A'), { recursive: true });
      await mkdir(join(tempRoot, 'Assets', 'Skip'), { recursive: true });
      await writeFile(join(tempRoot, 'Assets', 'B', 'Second.hlsl'), '');
      await writeFile(join(tempRoot, 'Assets', 'A', 'First.shader'), '');
      await writeFile(join(tempRoot, 'Assets', 'Skip', 'Ignored.hlsl'), '');
      await writeFile(join(tempRoot, 'Assets', 'A', 'Notes.txt'), '');

      const files = await walkFiles(tempRoot, ['Assets/Skip/**']);

      expect(files.map((file) => relative(tempRoot, file).replace(/\\/g, '/'))).toEqual([
        'Assets/A/First.shader',
        'Assets/B/Second.hlsl',
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
