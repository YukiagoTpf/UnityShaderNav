import type { Connection } from 'vscode-languageserver/node';
import {
  INCLUDE_POINT_CONTEXTS_REQUEST,
  type IncludePointContextsParams,
  type IncludePointContextsResult,
} from '@unity-shader-nav/shared';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';
import { createRequestHandler } from './documentRequest';

export function registerIncludePointContextsHandler(
  connection: Connection,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onRequest(
    INCLUDE_POINT_CONTEXTS_REQUEST,
    createRequestHandler<IncludePointContextsParams, IncludePointContextsResult>(suspender, {
      neutral: () => ({ contexts: [] }),
      resolve: (params) => manager.knownIncludePointContextsFor(params.textDocument.uri),
    }),
  );
}
