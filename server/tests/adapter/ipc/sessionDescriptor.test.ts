import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_SESSION_RELATIVE_PATH,
  decodeAdapterSessionDescriptor,
  discoverAdapterSession,
  unityProjectHash,
} from '../../../src/adapter/ipc/sessionDescriptor';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

async function unityRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usn-adapter-descriptor-'));
  roots.push(root);
  return root;
}

function descriptor(root: string) {
  return {
    protocolVersion: 1,
    adapterVersion: '0.1.0',
    unityVersion: '2022.3.62f1',
    projectHash: unityProjectHash(root),
    instanceId: 'editor-run-1',
    endpointKind: 'unix-domain-socket',
    endpoint: join(tmpdir(), 'usn-adapter-test.sock'),
    token: 'a'.repeat(64),
    processId: 123,
  } as const;
}

describe('Adapter session descriptor discovery', () => {
  it('accepts a current project-bound regular descriptor', async () => {
    const root = await unityRoot();
    const path = join(root, ADAPTER_SESSION_RELATIVE_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(descriptor(root)), 'utf8');

    await expect(discoverAdapterSession(root, 'darwin')).resolves.toEqual({
      status: 'available',
      path,
      descriptor: descriptor(root),
    });
  });

  it('rejects a foreign project hash and incompatible protocol', async () => {
    const root = await unityRoot();
    const path = join(root, ADAPTER_SESSION_RELATIVE_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      ...descriptor(root),
      projectHash: 'b'.repeat(64),
    }), 'utf8');
    await expect(discoverAdapterSession(root, 'darwin')).resolves.toEqual({
      status: 'unavailable',
      reason: 'foreign-project',
    });

    await writeFile(path, JSON.stringify({
      ...descriptor(root),
      protocolVersion: 2,
    }), 'utf8');
    await expect(discoverAdapterSession(root, 'darwin')).resolves.toEqual({
      status: 'unavailable',
      reason: 'version-incompatible',
    });
  });

  it('validates both platform endpoint spellings without TCP fallback', () => {
    expect(decodeAdapterSessionDescriptor({
      ...descriptor('/project'),
      projectHash: 'b'.repeat(64),
      endpointKind: 'named-pipe',
      endpoint: String.raw`\\.\pipe\UnityShaderNav-test`,
    }, 'win32')).toMatchObject({
      endpointKind: 'named-pipe',
      endpoint: String.raw`\\.\pipe\UnityShaderNav-test`,
    });
    expect(decodeAdapterSessionDescriptor({
      ...descriptor('/project'),
      projectHash: 'b'.repeat(64),
      endpoint: '/tmp/unity-shader-nav/test.sock',
    }, 'linux')).toMatchObject({
      endpointKind: 'unix-domain-socket',
    });
    expect(decodeAdapterSessionDescriptor({
      ...descriptor('/project'),
      projectHash: 'b'.repeat(64),
      endpointKind: 'named-pipe',
      endpoint: String.raw`\\.\pipe\UnityShaderNav-test`,
    }, 'darwin')).toBeUndefined();
    expect(decodeAdapterSessionDescriptor({
      ...descriptor('/project'),
      projectHash: 'b'.repeat(64),
      endpoint: '127.0.0.1:48123',
    }, 'linux')).toBeUndefined();
  });
});
