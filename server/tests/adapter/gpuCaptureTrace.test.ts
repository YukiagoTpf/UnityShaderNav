import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyLocalGpuTrace } from '../../src/adapter/gpuCaptureTrace';

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('local GPU trace verification', () => {
  it('hashes a regular trace file and observes only the requested label', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-gpu-trace-file-'));
    const trace = join(root, 'CaptureProbe.gputrace');
    const bytes = Buffer.from('prefix\0revision-bound-label\0suffix');
    try {
      await writeFile(trace, bytes);

      await expect(
        verifyLocalGpuTrace(trace, 'revision-bound-label'),
      ).resolves.toEqual({
        status: 'verified-local-trace',
        fileName: 'CaptureProbe.gputrace',
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        labels: ['revision-bound-label'],
      });
      await expect(
        verifyLocalGpuTrace(trace, 'another-label'),
      ).resolves.toMatchObject({ labels: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'accepts an internal relative file symlink using the Unity tree identity',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'usn-gpu-trace-link-'));
      const trace = join(root, 'CaptureProbe.gputrace');
      const resource = Buffer.from('revision-bound-label');
      try {
        await mkdir(trace);
        await writeFile(join(trace, 'resource.bin'), resource);
        await symlink('resource.bin', join(trace, 'resource-alias.bin'));

        const identity = [
          `/resource-alias.bin\0${sha256(resource)}\n`,
          `/resource.bin\0${sha256(resource)}\n`,
        ].join('');
        await expect(
          verifyLocalGpuTrace(trace, 'revision-bound-label'),
        ).resolves.toEqual({
          status: 'verified-local-trace',
          fileName: 'CaptureProbe.gputrace',
          sha256: sha256(identity),
          byteLength: resource.byteLength * 2,
          labels: ['revision-bound-label'],
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a trace symlink that escapes the document root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'usn-gpu-trace-escape-'));
      const trace = join(root, 'CaptureProbe.gputrace');
      try {
        await mkdir(trace);
        await writeFile(join(root, 'outside.bin'), 'outside');
        await symlink('../outside.bin', join(trace, 'escape.bin'));

        await expect(
          verifyLocalGpuTrace(trace, undefined),
        ).rejects.toThrow('trace document symlink escapes its root');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a symlink as the trace root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'usn-gpu-trace-root-link-'));
      const trace = join(root, 'CaptureProbe.gputrace');
      const link = join(root, 'Linked.gputrace');
      try {
        await writeFile(trace, 'trace');
        await symlink('CaptureProbe.gputrace', link);

        await expect(
          verifyLocalGpuTrace(link, undefined),
        ).rejects.toThrow('trace root must not be a symlink');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
