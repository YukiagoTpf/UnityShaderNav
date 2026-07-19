import type {
  AdapterStatus,
  AdapterUnavailableReason,
} from '@unity-shader-nav/shared';
import type { IndexStatusDetail } from './indexStatus';

export interface ClientOutput {
  appendLine(value: string): void;
}

export type ClientErrorReporter = (message: string, error: unknown) => void;

export function reportClientError(
  output: ClientOutput,
  message: string,
  error: unknown,
): void {
  const detail = error instanceof Error
    ? error.stack ?? `${error.name}: ${error.message}`
    : String(error);
  output.appendLine(`[Error] ${message}\n${detail}`);
}

export function reportIndexStatus(
  output: ClientOutput,
  details: readonly IndexStatusDetail[],
): void {
  output.appendLine('[Index Status]');
  for (const status of details) {
    output.appendLine([
      status.label.replace(/^\$\([^)]+\)\s*/, ''),
      status.description,
      status.detail,
    ].filter((part): part is string => part !== undefined).join(' · '));
  }
}

const ADAPTER_UNAVAILABLE_LABELS: Readonly<Record<AdapterUnavailableReason, string>> = {
  'no-adapter': 'no Adapter available',
  stale: 'stale handshake rejected',
  'foreign-project': 'foreign project rejected',
  disconnected: 'Adapter disconnected',
  'version-incompatible': 'incompatible interface version rejected',
};

export function reportAdapterStatus(
  output: ClientOutput,
  status: AdapterStatus,
): void {
  if (status.mode === 'standalone') {
    output.appendLine(`[Adapter] Standalone · ${ADAPTER_UNAVAILABLE_LABELS[status.reason]}`);
    return;
  }

  const capabilities = status.capabilities;
  const supportedFeatures = capabilities.supportedFeatures.length > 0
    ? capabilities.supportedFeatures.join(', ')
    : 'none';
  output.appendLine([
    '[Adapter] Connected',
    `Unity ${capabilities.unityVersion}`,
    `project ${capabilities.projectId}`,
    `Adapter ${capabilities.adapterVersion}`,
    `features: ${supportedFeatures}`,
  ].join(' · '));
}
