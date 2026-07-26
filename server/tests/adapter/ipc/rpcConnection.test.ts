import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdapterFrameDecoder,
  encodeAdapterFrame,
} from '../../../src/adapter/ipc/framing';
import type {
  AdapterProtocolMessage,
  AdapterSessionDescriptor,
} from '../../../src/adapter/ipc/protocol';
import {
  AdapterConnectionError,
  AdapterRpcConnection,
} from '../../../src/adapter/ipc/rpcConnection';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function endpoint(): Promise<string> {
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\UnityShaderNav-${randomUUID()}`;
  }
  const root = await mkdtemp(join(tmpdir(), 'usn-adapter-rpc-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return join(root, 'adapter.sock');
}

function descriptor(path: string): AdapterSessionDescriptor {
  return {
    protocolVersion: 1,
    adapterVersion: '0.1.0',
    unityVersion: '2022.3.62f1',
    projectHash: 'b'.repeat(64),
    instanceId: 'editor-run-1',
    endpointKind: process.platform === 'win32'
      ? 'named-pipe'
      : 'unix-domain-socket',
    endpoint: path,
    token: 'a'.repeat(64),
    processId: process.pid,
  };
}

async function listen(
  onMessage: (message: AdapterProtocolMessage, socket: Socket) => void,
): Promise<{ server: Server; descriptor: AdapterSessionDescriptor }> {
  const path = await endpoint();
  const server = createServer((socket) => {
    const decoder = new AdapterFrameDecoder();
    socket.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) onMessage(message, socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, descriptor: descriptor(path) };
}

function welcome(socket: Socket): void {
  socket.write(encodeAdapterFrame({
    type: 'welcome',
    protocolVersion: 1,
    adapterVersion: '0.1.0',
    unityVersion: '2022.3.62f1',
    projectHash: 'b'.repeat(64),
    instanceId: 'editor-run-1',
    capabilities: [{ name: 'material-context', version: 1 }],
  }));
}

describe('Adapter descriptor-bound RPC connection', () => {
  it('handshakes, correlates a capability response, and publishes events', async () => {
    const seen: AdapterProtocolMessage[] = [];
    const fixture = await listen((message, socket) => {
      seen.push(message);
      if (message.type === 'hello') {
        welcome(socket);
      } else if (message.type === 'request') {
        socket.write(encodeAdapterFrame({
          type: 'response',
          id: message.id,
          ok: true,
          result: { status: 'none' },
        }));
        socket.write(encodeAdapterFrame({
          type: 'event',
          capability: 'material-context',
          event: 'selection-changed',
        }));
      }
    });
    const connection = await AdapterRpcConnection.connect(fixture.descriptor);
    cleanups.push(() => connection.close());
    const events: string[] = [];
    // The fixture writes the response and the event back to back. A Unix domain
    // socket usually delivers both in one read, but a Windows named pipe can
    // split them, so await the event itself instead of a fixed number of ticks.
    const firstEvent = new Promise<void>((resolve) => {
      connection.onDidReceiveEvent((event) => {
        events.push(event.event);
        resolve();
      });
    });

    await expect(connection.request(
      'material-context',
      'get-selected-material-context',
    )).resolves.toEqual({ status: 'none' });
    await firstEvent;

    expect(seen).toEqual([
      {
        type: 'hello',
        token: 'a'.repeat(64),
        protocolVersion: 1,
        projectHash: 'b'.repeat(64),
      },
      {
        type: 'request',
        id: 'editor-run-1:1',
        capability: 'material-context',
        method: 'get-selected-material-context',
      },
    ]);
    expect(events).toEqual(['selection-changed']);
  });

  it('rejects welcome identity that differs from the descriptor', async () => {
    const fixture = await listen((message, socket) => {
      if (message.type !== 'hello') return;
      socket.write(encodeAdapterFrame({
        type: 'welcome',
        protocolVersion: 1,
        adapterVersion: '0.1.0',
        unityVersion: '2022.3.62f1',
        projectHash: 'c'.repeat(64),
        instanceId: 'editor-run-1',
        capabilities: [],
      }));
    });

    await expect(AdapterRpcConnection.connect(fixture.descriptor))
      .rejects.toMatchObject<Partial<AdapterConnectionError>>({
        code: 'protocol',
      });
  });

  it('surfaces stable handshake rejection reasons without exposing the token', async () => {
    const fixture = await listen((message, socket) => {
      if (message.type !== 'hello') return;
      socket.write(encodeAdapterFrame({
        type: 'reject',
        reason: 'token',
      }));
    });

    await expect(AdapterRpcConnection.connect(fixture.descriptor))
      .rejects.toMatchObject<Partial<AdapterConnectionError>>({
        code: 'token',
        message: 'Adapter rejected the handshake: token',
      });
  });

  it('ignores a late response after cancellation without dropping the stream', async () => {
    let requests = 0;
    const fixture = await listen((message, socket) => {
      if (message.type === 'hello') {
        welcome(socket);
        return;
      }
      if (message.type !== 'request') return;
      requests++;
      const response = encodeAdapterFrame({
        type: 'response',
        id: message.id,
        ok: true,
        result: { request: requests },
      });
      if (requests === 1) setTimeout(() => socket.write(response), 10);
      else socket.write(response);
    });
    const connection = await AdapterRpcConnection.connect(fixture.descriptor);
    cleanups.push(() => connection.close());
    const controller = new AbortController();
    const cancelled = connection.request(
      'material-context',
      'get-selected-material-context',
      undefined,
      controller.signal,
    );
    controller.abort();

    await expect(cancelled).rejects.toMatchObject<
      Partial<AdapterConnectionError>
    >({ code: 'cancelled' });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await expect(connection.request(
      'material-context',
      'get-selected-material-context',
    )).resolves.toEqual({ request: 2 });
  });
});
