import { createConnection, type Socket } from 'node:net';
import {
  AdapterFrameDecoder,
  AdapterFrameError,
  encodeAdapterFrame,
} from './framing';
import {
  ADAPTER_PROTOCOL_VERSION,
  type AdapterHello,
  type AdapterProtocolMessage,
  type AdapterReject,
  type AdapterRpcEvent,
  type AdapterRpcRequest,
  type AdapterRpcResponse,
  type AdapterSessionDescriptor,
  type AdapterWelcome,
} from './protocol';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class AdapterConnectionError extends Error {
  constructor(
    readonly code:
      | 'connect'
      | 'closed'
      | 'cancelled'
      | 'timeout'
      | 'protocol'
      | 'token'
      | 'project'
      | 'remote',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterConnectionError';
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly dispose: () => void;
}

export interface AdapterRpcConnectionOptions {
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validWelcome(
  value: unknown,
  descriptor: AdapterSessionDescriptor,
): value is AdapterWelcome {
  if (!isRecord(value) || value.type !== 'welcome') return false;
  if (
    value.protocolVersion !== ADAPTER_PROTOCOL_VERSION
    || value.protocolVersion !== descriptor.protocolVersion
    || value.adapterVersion !== descriptor.adapterVersion
    || value.unityVersion !== descriptor.unityVersion
    || value.projectHash !== descriptor.projectHash
    || value.instanceId !== descriptor.instanceId
    || !Array.isArray(value.capabilities)
  ) return false;

  const names = new Set<string>();
  return value.capabilities.every((capability) => {
    if (
      !isRecord(capability)
      || typeof capability.name !== 'string'
      || capability.name.trim().length === 0
      || !Number.isInteger(capability.version)
      || Number(capability.version) <= 0
      || names.has(capability.name)
    ) return false;
    names.add(capability.name);
    return true;
  });
}

function isReject(value: unknown): value is AdapterReject {
  return isRecord(value)
    && value.type === 'reject'
    && (
      value.reason === 'token'
      || value.reason === 'protocol'
      || value.reason === 'project'
    );
}

function isResponse(value: unknown): value is AdapterRpcResponse {
  if (
    !isRecord(value)
    || value.type !== 'response'
    || typeof value.id !== 'string'
    || typeof value.ok !== 'boolean'
  ) return false;
  if (value.ok) return Object.hasOwn(value, 'result');
  return isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string';
}

function isEvent(value: unknown): value is AdapterRpcEvent {
  return isRecord(value)
    && value.type === 'event'
    && typeof value.capability === 'string'
    && value.capability.trim().length > 0
    && typeof value.event === 'string'
    && value.event.trim().length > 0;
}

/**
 * One authenticated Adapter stream. It owns request correlation and ensures
 * no payload is exposed before the descriptor-bound handshake succeeds.
 */
export class AdapterRpcConnection {
  private readonly decoder = new AdapterFrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly ignoredResponseIds = new Set<string>();
  private readonly eventListeners = new Set<(event: AdapterRpcEvent) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly requestTimeoutMs: number;
  private welcome: AdapterWelcome | undefined;
  private handshakeResolve: ((welcome: AdapterWelcome) => void) | undefined;
  private handshakeReject: ((error: Error) => void) | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private requestSequence = 0;
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly descriptor: AdapterSessionDescriptor,
    options: AdapterRpcConnectionOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs
      ?? DEFAULT_REQUEST_TIMEOUT_MS;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => { this.handleData(chunk); });
    socket.once('error', (error) => { this.closeWithError(error); });
    socket.once('close', () => { this.closeWithError(); });
  }

  static async connect(
    descriptor: AdapterSessionDescriptor,
    options: AdapterRpcConnectionOptions = {},
  ): Promise<AdapterRpcConnection> {
    const socket = createConnection(descriptor.endpoint);
    const connection = new AdapterRpcConnection(socket, descriptor, options);
    return connection.performHandshake(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
  }

  get handshake(): AdapterWelcome {
    if (!this.welcome) {
      throw new AdapterConnectionError(
        'protocol',
        'Adapter handshake has not completed',
      );
    }
    return this.welcome;
  }

  async request<Result>(
    capability: string,
    method: string,
    params?: unknown,
    cancellation?: AbortSignal,
  ): Promise<Result> {
    if (this.closed || !this.welcome) {
      throw new AdapterConnectionError('closed', 'Adapter connection is closed');
    }
    if (
      !this.welcome.capabilities.some((entry) => entry.name === capability)
    ) {
      throw new AdapterConnectionError(
        'protocol',
        `Adapter does not advertise capability '${capability}'`,
      );
    }
    if (method.trim().length === 0) {
      throw new AdapterConnectionError('protocol', 'Adapter method is empty');
    }
    if (cancellation?.aborted) {
      throw new AdapterConnectionError(
        'cancelled',
        `Adapter request '${capability}/${method}' was cancelled`,
      );
    }

    const id = `${this.welcome.instanceId}:${++this.requestSequence}`;
    const request: AdapterRpcRequest = {
      type: 'request',
      id,
      capability,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise<Result>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.ignoredResponseIds.add(id);
        dispose();
        reject(new AdapterConnectionError(
          'cancelled',
          `Adapter request '${capability}/${method}' was cancelled`,
        ));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.ignoredResponseIds.add(id);
        cancellation?.removeEventListener('abort', onAbort);
        reject(new AdapterConnectionError(
          'timeout',
          `Adapter request '${capability}/${method}' timed out`,
        ));
      }, this.requestTimeoutMs);
      const dispose = () => {
        clearTimeout(timer);
        cancellation?.removeEventListener('abort', onAbort);
      };
      cancellation?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { resolve(value as Result); },
        reject,
        dispose,
      });
      try {
        this.socket.write(encodeAdapterFrame(request));
      } catch (error) {
        dispose();
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onDidReceiveEvent(
    listener: (event: AdapterRpcEvent) => void,
  ): { dispose(): void } {
    this.eventListeners.add(listener);
    return { dispose: () => { this.eventListeners.delete(listener); } };
  }

  onDidClose(listener: (error?: Error) => void): { dispose(): void } {
    if (this.closed) {
      queueMicrotask(() => { listener(); });
      return { dispose() {} };
    }
    this.closeListeners.add(listener);
    return { dispose: () => { this.closeListeners.delete(listener); } };
  }

  close(): void {
    this.closeWithError();
  }

  private performHandshake(timeoutMs: number): Promise<AdapterRpcConnection> {
    const hello: AdapterHello = {
      type: 'hello',
      token: this.descriptor.token,
      protocolVersion: ADAPTER_PROTOCOL_VERSION,
      projectHash: this.descriptor.projectHash,
    };
    return new Promise<AdapterRpcConnection>((resolve, reject) => {
      this.handshakeResolve = (welcome) => {
        this.welcome = welcome;
        resolve(this);
      };
      this.handshakeReject = reject;
      this.handshakeTimer = setTimeout(() => {
        this.closeWithError(new AdapterConnectionError(
          'timeout',
          'Adapter handshake timed out',
        ));
      }, timeoutMs);
      this.socket.once('connect', () => {
        try {
          this.socket.write(encodeAdapterFrame(hello));
        } catch (error) {
          this.closeWithError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    });
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    try {
      for (const message of this.decoder.push(chunk)) {
        this.handleMessage(message);
      }
    } catch (error) {
      const cause = error instanceof AdapterFrameError
        ? error
        : new AdapterFrameError(String(error));
      this.closeWithError(cause);
    }
  }

  private handleMessage(message: AdapterProtocolMessage): void {
    if (!this.welcome) {
      if (validWelcome(message, this.descriptor)) {
        this.finishHandshake(message);
        return;
      }
      if (isReject(message)) {
        this.closeWithError(new AdapterConnectionError(
          message.reason,
          `Adapter rejected the handshake: ${message.reason}`,
        ));
        return;
      }
      this.closeWithError(new AdapterConnectionError(
        'protocol',
        'Adapter sent an invalid descriptor-bound welcome',
      ));
      return;
    }

    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (this.ignoredResponseIds.delete(message.id)) return;
        this.closeWithError(new AdapterConnectionError(
          'protocol',
          `Adapter returned unknown request id '${message.id}'`,
        ));
        return;
      }
      this.pending.delete(message.id);
      pending.dispose();
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new AdapterConnectionError(
        'remote',
        `${message.error.code}: ${message.error.message}`,
      ));
      return;
    }
    if (isEvent(message)) {
      for (const listener of [...this.eventListeners]) listener(message);
      return;
    }
    this.closeWithError(new AdapterConnectionError(
      'protocol',
      'Adapter sent an unexpected post-handshake message',
    ));
  }

  private finishHandshake(welcome: AdapterWelcome): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const resolve = this.handshakeResolve;
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
    resolve?.(welcome);
  }

  private closeWithError(cause?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const error = cause instanceof AdapterConnectionError
      ? cause
      : new AdapterConnectionError(
          cause ? 'connect' : 'closed',
          cause?.message ?? 'Adapter connection closed',
        );
    this.handshakeReject?.(error);
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
    for (const pending of this.pending.values()) {
      pending.dispose();
      pending.reject(error);
    }
    this.pending.clear();
    this.ignoredResponseIds.clear();
    this.socket.destroy();
    for (const listener of [...this.closeListeners]) listener(cause);
    this.closeListeners.clear();
    this.eventListeners.clear();
  }
}
