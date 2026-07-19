import type { Connection } from 'vscode-languageserver/node';
import {
  MATERIAL_CONTEXT_CHANGED_NOTIFICATION,
  MATERIAL_CONTEXT_REQUEST,
  type MaterialContextParams,
  type MaterialContextResult,
} from '@unity-shader-nav/shared';
import type { AdapterRegistry } from '../adapter/adapterRegistry';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';
import { createRequestHandler } from './documentRequest';

export function registerMaterialContextHandler(
  connection: Connection,
  manager: WorkspaceManager,
  registry?: Pick<AdapterRegistry, 'onDidChangeMaterialContext'>,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onRequest(
    MATERIAL_CONTEXT_REQUEST,
    createRequestHandler<MaterialContextParams, MaterialContextResult>(suspender, {
      neutral: () => ({ status: 'unavailable', reason: 'source-unavailable' }),
      resolve: (params) => manager.materialContextFor(params.textDocument.uri),
    }),
  );

  registry?.onDidChangeMaterialContext(() => {
    manager.invalidateMaterialContexts();
    const reportFailure = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      connection.console.error(
        `[UnityShaderNav] Material Context notification failed: ${message}`,
      );
    };
    try {
      void Promise.resolve(
        connection.sendNotification(MATERIAL_CONTEXT_CHANGED_NOTIFICATION),
      ).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  });
}
