import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  AdapterHandshake,
} from '@unity-shader-nav/shared';
import {
  AdapterFrameDecoder,
  encodeAdapterFrame,
} from '../../../src/adapter/ipc/framing';
import type {
  AdapterProtocolMessage,
  AdapterSessionDescriptor,
} from '../../../src/adapter/ipc/protocol';
import {
  UnityAdapterClient,
  type AdapterLifecycleRegistry,
} from '../../../src/adapter/ipc/unityAdapterClient';
import type {
  AdapterConnectionSources,
} from '../../../src/adapter/adapterRegistry';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface RegistryCall {
  readonly projectId: string;
  readonly handshake: AdapterHandshake;
  readonly sources: AdapterConnectionSources | undefined;
}

class RecordingRegistry implements AdapterLifecycleRegistry {
  readonly registrations: RegistryCall[] = [];
  disconnects = 0;

  registerHandshake(
    projectId: string,
    handshake: AdapterHandshake,
    sources?: AdapterConnectionSources,
  ): void {
    this.registrations.push({ projectId, handshake, sources });
  }

  disconnect(): void {
    this.disconnects++;
  }
}

async function endpoint(): Promise<string> {
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\UnityShaderNav-${randomUUID()}`;
  }
  const root = await mkdtemp(join(tmpdir(), 'usn-adapter-client-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return join(root, 'adapter.sock');
}

function descriptor(path: string, instanceId: string): AdapterSessionDescriptor {
  return {
    protocolVersion: 1,
    adapterVersion: '0.1.0',
    unityVersion: '2022.3.62f1',
    projectHash: 'b'.repeat(64),
    instanceId,
    endpointKind: process.platform === 'win32'
      ? 'named-pipe'
      : 'unix-domain-socket',
    endpoint: path,
    token: 'a'.repeat(64),
    processId: process.pid,
  };
}

async function adapterHost(instanceId: string): Promise<{
  readonly server: Server;
  readonly descriptor: AdapterSessionDescriptor;
  closeStream(): void;
}> {
  const path = await endpoint();
  let client: Socket | undefined;
  const server = createServer((socket) => {
    client = socket;
    const decoder = new AdapterFrameDecoder();
    socket.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
        respond(message, socket, instanceId);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    server,
    descriptor: descriptor(path, instanceId),
    closeStream() {
      client?.destroy();
    },
  };
}

function respond(
  message: AdapterProtocolMessage,
  socket: Socket,
  instanceId: string,
): void {
  if (message.type === 'hello') {
    socket.write(encodeAdapterFrame({
      type: 'welcome',
      protocolVersion: 1,
      adapterVersion: '0.1.0',
      unityVersion: '2022.3.62f1',
      projectHash: 'b'.repeat(64),
      instanceId,
      capabilities: [{ name: 'material-context', version: 1 }],
    }));
    return;
  }
  if (message.type === 'request') {
    socket.write(encodeAdapterFrame({
      type: 'response',
      id: message.id,
      ok: true,
      result: { status: 'none' },
    }));
  }
}

function available(session: AdapterSessionDescriptor) {
  return async () => ({
    status: 'available' as const,
    path: '/derived/session.json',
    descriptor: session,
  });
}

describe('Unity Adapter per-root lifecycle', () => {
  it('registers the descriptor-bound handshake and Material Context source', async () => {
    const host = await adapterHost('editor-run-1');
    const registry = new RecordingRegistry();
    const client = new UnityAdapterClient({
      unityRoot: '/project',
      registry,
      now: () => 42,
      discover: available(host.descriptor),
    });
    cleanups.push(() => client.stop());

    await client.start();

    expect(registry.registrations).toHaveLength(1);
    expect(registry.registrations[0]).toMatchObject({
      projectId: 'b'.repeat(64),
      handshake: {
        interfaceVersion: 1,
        issuedAt: 42,
        instanceId: 'editor-run-1',
        capabilities: {
          projectId: 'b'.repeat(64),
          supportedFeatures: ['material-context'],
        },
      },
    });
    await expect(
      registry.registrations[0]?.sources?.materialContext
        ?.selectedMaterialContext(),
    ).resolves.toEqual({ status: 'none' });
  });

  it('disconnects only the registry exclusively owned by the dropped root', async () => {
    const firstHost = await adapterHost('editor-run-1');
    const secondHost = await adapterHost('editor-run-2');
    const firstRegistry = new RecordingRegistry();
    const secondRegistry = new RecordingRegistry();
    const first = new UnityAdapterClient({
      unityRoot: '/first',
      registry: firstRegistry,
      discover: available(firstHost.descriptor),
    });
    const second = new UnityAdapterClient({
      unityRoot: '/second',
      registry: secondRegistry,
      discover: available(secondHost.descriptor),
    });
    cleanups.push(() => first.stop(), () => second.stop());
    await Promise.all([first.start(), second.start()]);

    secondHost.closeStream();
    await vi.waitFor(() => {
      expect(secondRegistry.disconnects).toBe(1);
    });

    expect(firstRegistry.disconnects).toBe(0);
    expect(first.state.status).toBe('connected');
    expect(second.state).toEqual({
      status: 'unavailable',
      reason: 'disconnected',
    });
  });

  it('retries failed endpoints with bounded exponential backoff', async () => {
    vi.useFakeTimers();
    const session = descriptor('/tmp/unreachable.sock', 'editor-run-1');
    const registry = new RecordingRegistry();
    const connect = vi.fn(async () => {
      throw new Error('refused');
    });
    const client = new UnityAdapterClient({
      unityRoot: '/project',
      registry,
      random: () => 0.5,
      reconnectBaseMs: 1_000,
      reconnectCapMs: 2_000,
      discover: available(session),
      connect,
    });

    await client.start();
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);

    client.stop();
  });
});
