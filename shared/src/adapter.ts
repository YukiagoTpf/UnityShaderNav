/** Custom pull request: client asks for the current Unity Editor Adapter status. */
export const ADAPTER_STATUS_REQUEST = 'unityShaderNav/adapterStatus';

/** Version of the handshake contract, independent from the Adapter release version. */
export const ADAPTER_INTERFACE_VERSION = 1;

export interface AdapterCapabilities {
  readonly unityVersion: string;
  readonly projectId: string;
  readonly adapterVersion: string;
  readonly supportedFeatures: readonly string[];
}

/** Evidence supplied by one local Adapter connection. */
export interface AdapterHandshake {
  readonly interfaceVersion: number;
  readonly issuedAt: number;
  readonly capabilities: AdapterCapabilities;
}

export type AdapterUnavailableReason =
  | 'no-adapter'
  | 'stale'
  | 'foreign-project'
  | 'disconnected'
  | 'version-incompatible';

export type AdapterStatus =
  | {
      readonly mode: 'adapter';
      readonly capabilities: AdapterCapabilities;
    }
  | {
      readonly mode: 'standalone';
      readonly reason: AdapterUnavailableReason;
    };
