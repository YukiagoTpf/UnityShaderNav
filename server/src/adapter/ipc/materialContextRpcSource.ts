import { MATERIAL_CONTEXT_ADAPTER_FEATURE } from '@unity-shader-nav/shared';
import type {
  MaterialContextSource,
  MaterialContextSourceIdentity,
  MaterialContextSourceSnapshot,
} from '../materialContextSource';
import type { AdapterRpcConnection } from './rpcConnection';

export const GET_SELECTED_MATERIAL_CONTEXT_METHOD =
  'get-selected-material-context';
export const MATERIAL_CONTEXT_SELECTION_CHANGED_EVENT = 'selection-changed';

export class MaterialContextRpcSource implements MaterialContextSource {
  constructor(
    readonly identity: MaterialContextSourceIdentity,
    private readonly connection: AdapterRpcConnection,
  ) {}

  selectedMaterialContext(): Promise<MaterialContextSourceSnapshot> {
    return this.connection.request<MaterialContextSourceSnapshot>(
      MATERIAL_CONTEXT_ADAPTER_FEATURE,
      GET_SELECTED_MATERIAL_CONTEXT_METHOD,
    );
  }

  onDidChangeSelection(listener: () => void): { dispose(): void } {
    return this.connection.onDidReceiveEvent((event) => {
      if (
        event.capability === MATERIAL_CONTEXT_ADAPTER_FEATURE
        && event.event === MATERIAL_CONTEXT_SELECTION_CHANGED_EVENT
      ) listener();
    });
  }
}
