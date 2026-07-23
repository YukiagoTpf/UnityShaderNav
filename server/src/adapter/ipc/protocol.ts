import { ADAPTER_INTERFACE_VERSION } from '@unity-shader-nav/shared';

/** ADR-0008 transport version. Feature payloads version independently. */
export const ADAPTER_PROTOCOL_VERSION = ADAPTER_INTERFACE_VERSION;

/** Bound untrusted local frames before allocating their JSON payload. */
export const MAX_ADAPTER_FRAME_BYTES = 8 * 1024 * 1024;

export type AdapterEndpointKind = 'named-pipe' | 'unix-domain-socket';

export interface AdapterSessionDescriptor {
  readonly protocolVersion: number;
  readonly adapterVersion: string;
  readonly unityVersion: string;
  readonly projectHash: string;
  readonly instanceId: string;
  readonly endpointKind: AdapterEndpointKind;
  readonly endpoint: string;
  readonly token: string;
  readonly processId: number;
}

export interface AdapterCapabilityDescriptor {
  readonly name: string;
  readonly version: number;
}

export interface AdapterHello {
  readonly type: 'hello';
  readonly token: string;
  readonly protocolVersion: number;
  readonly projectHash: string;
}

export interface AdapterWelcome {
  readonly type: 'welcome';
  readonly protocolVersion: number;
  readonly adapterVersion: string;
  readonly unityVersion: string;
  readonly projectHash: string;
  readonly instanceId: string;
  readonly capabilities: readonly AdapterCapabilityDescriptor[];
}

export type AdapterRejectReason = 'token' | 'protocol' | 'project';

export interface AdapterReject {
  readonly type: 'reject';
  readonly reason: AdapterRejectReason;
}

export interface AdapterRpcRequest {
  readonly type: 'request';
  readonly id: string;
  readonly capability: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface AdapterRpcError {
  readonly code: string;
  readonly message: string;
}

export type AdapterRpcResponse =
  | {
      readonly type: 'response';
      readonly id: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly type: 'response';
      readonly id: string;
      readonly ok: false;
      readonly error: AdapterRpcError;
    };

export interface AdapterRpcEvent {
  readonly type: 'event';
  readonly capability: string;
  readonly event: string;
  readonly payload?: unknown;
}

export type AdapterProtocolMessage =
  | AdapterHello
  | AdapterWelcome
  | AdapterReject
  | AdapterRpcRequest
  | AdapterRpcResponse
  | AdapterRpcEvent;
