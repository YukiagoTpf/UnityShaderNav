import { promises as fs } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { detectUnityRoot } from '../../src/workspace/detectUnityRoot';

const fixtureA = resolve(__dirname, '../include/fixtures/projectA');

describe('detectUnityRoot', () => {
  it('returns root when both Assets/ and ProjectSettings/ exist', async () => {
    expect(await detectUnityRoot(fixtureA)).toBe(fixtureA);
  });

  it('walks up from a nested folder', async () => {
    const nested = join(fixtureA, 'Assets/Shaders/Inner');
    expect(await detectUnityRoot(nested)).toBe(fixtureA);
  });

  it('returns null when neither exists', async () => {
    expect(await detectUnityRoot('/tmp')).toBeNull();
  });

  it('surfaces inspection failures instead of treating them as a standalone root', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'stat').mockRejectedValue(failure);

    await expect(detectUnityRoot('/restricted/project')).rejects.toThrow(
      /Unable to inspect .*Assets: permission denied/,
    );
  });
});
