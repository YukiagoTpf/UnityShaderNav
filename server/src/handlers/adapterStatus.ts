import {
  ADAPTER_STATUS_REQUEST,
  type AdapterStatus,
} from '@unity-shader-nav/shared';
import type { CancellationToken, Connection } from 'vscode-languageserver/node';
import type { AdapterRegistry } from '../adapter/adapterRegistry';
import { throwIfRequestCancelled } from '../lifecycle/requestCancellation';

export function registerAdapterStatusHandler(
  connection: Connection,
  registry: Pick<AdapterRegistry, 'status'>,
): void {
  connection.onRequest(
    ADAPTER_STATUS_REQUEST,
    (_params: unknown, cancellation: CancellationToken): AdapterStatus => {
      throwIfRequestCancelled(cancellation);
      return registry.status();
    },
  );
}
