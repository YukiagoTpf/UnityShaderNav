import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join, relative, resolve } from 'node:path';
import { walkFiles } from '../../src/workspace/walkFiles';

const fsMock = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  delayMs: 0,
  failPath: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: async (...args: Parameters<typeof actual.promises.readdir>) => {
        fsMock.active++;
        fsMock.maxActive = Math.max(fsMock.maxActive, fsMock.active);
        try {
          if (fsMock.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, fsMock.delayMs));
          }
          if (fsMock.failPath === String(args[0])) {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          }
          return await actual.promises.readdir(...args);
        } finally {
          fsMock.active--;
        }
      },
    },
  };
});

const root = resolve(__dirname, '../include/fixtures/projectA');

const rel = (file: string): string => relative(root, file).replace(/\\/g, '/');

afterEach(() => {
  fsMock.active = 0;
  fsMock.maxActive = 0;
  fsMock.delayMs = 0;
  fsMock.failPath = undefined;
});

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

  it('caps directory reads across the whole walk', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'usn-walk-cap-'));
    try {
      for (let i = 0; i < 40; i++) {
        await mkdir(join(tempRoot, `Dir${i}`, 'Nested'), { recursive: true });
        await writeFile(join(tempRoot, `Dir${i}`, 'Nested', `File${i}.hlsl`), '');
      }

      fsMock.delayMs = 5;
      const files = await walkFiles(tempRoot, []);

      expect(files).toHaveLength(40);
      expect(fsMock.maxActive).toBeLessThanOrEqual(16);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects incomplete traversal instead of returning a partial file list', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'usn-walk-failure-'));
    const blocked = join(tempRoot, 'Blocked');
    try {
      await mkdir(blocked, { recursive: true });
      await writeFile(join(blocked, 'Hidden.hlsl'), '');
      fsMock.failPath = blocked;

      await expect(walkFiles(tempRoot, [])).rejects.toThrow(
        /Unable to traverse .*Blocked: permission denied/,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('stops traversal when its workspace lifetime is aborted', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'usn-walk-abort-'));
    try {
      await mkdir(join(tempRoot, 'Assets'), { recursive: true });
      await writeFile(join(tempRoot, 'Assets', 'File.hlsl'), '');
      fsMock.delayMs = 5;
      const controller = new AbortController();

      const walking = walkFiles(tempRoot, [], controller.signal);
      controller.abort(new Error('workspace retired'));

      await expect(walking).rejects.toThrow('workspace retired');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
