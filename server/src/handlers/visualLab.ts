import type { Connection } from 'vscode-languageserver/node';
import {
  VISUAL_LAB_CAPTURE_REQUEST,
  VISUAL_LAB_SELECT_TARGET_REQUEST,
  VISUAL_LAB_STATE_REQUEST,
  type VisualLabCaptureParams,
  type VisualLabSelectTargetParams,
  type VisualLabSessionState,
  type VisualLabStateParams,
} from '@unity-shader-nav/shared';
import type { VisualLabService } from '../adapter/visualLabService';

export type VisualLabServiceResolver = (
  documentUri: string,
) => VisualLabService | undefined;

/**
 * Register only URI-routed request handlers. A workspace coordinator owns
 * dynamic service subscriptions and full-snapshot notifications.
 */
export function registerVisualLabHandlers(
  connection: Connection,
  serviceFor: VisualLabServiceResolver,
): void {
  connection.onRequest(
    VISUAL_LAB_STATE_REQUEST,
    (params: VisualLabStateParams): VisualLabSessionState => (
      serviceFor(params.textDocument.uri)?.state() ?? unavailableState()
    ),
  );

  connection.onRequest(
    VISUAL_LAB_SELECT_TARGET_REQUEST,
    async (
      params: VisualLabSelectTargetParams,
    ): Promise<VisualLabSessionState> => (
      await serviceFor(params.textDocument.uri)?.selectCurrentTarget(
        params.textDocument.uri,
      )
      ?? unavailableState()
    ),
  );

  connection.onRequest(
    VISUAL_LAB_CAPTURE_REQUEST,
    async (params: VisualLabCaptureParams): Promise<VisualLabSessionState> => {
      const service = serviceFor(params.textDocument.uri);
      if (!service) return unavailableState();
      if (params.slot !== 'before' && params.slot !== 'after') {
        return service.state();
      }
      return service.capture(params.slot);
    },
  );
}

function unavailableState(): VisualLabSessionState {
  return {
    status: 'unavailable',
    reason: 'no-adapter',
    before: { status: 'empty', slot: 'before' },
    after: { status: 'empty', slot: 'after' },
  };
}
