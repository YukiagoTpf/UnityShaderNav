import {
  PROPERTY_RENAME_BEGIN_REQUEST,
  PROPERTY_RENAME_FINISH_REQUEST,
  PROPERTY_RENAME_PREVIEW_REQUEST,
  type PropertyRenameBeginParams,
  type PropertyRenameBeginResult,
  type PropertyRenameFinishParams,
  type PropertyRenameFinishResult,
  type PropertyRenameParams,
  type PropertyRenamePreviewResult,
} from '@unity-shader-nav/shared';
import type { CancellationToken, Connection } from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { throwIfRequestCancelled } from '../lifecycle/requestCancellation';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

function validRenameParams(params: PropertyRenameParams): boolean {
  return typeof params?.textDocument?.uri === 'string'
    && Number.isInteger(params?.position?.line)
    && params.position.line >= 0
    && Number.isInteger(params?.position?.character)
    && params.position.character >= 0
    && typeof params.newName === 'string';
}

export function registerPropertyRenameHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onRequest(
    PROPERTY_RENAME_PREVIEW_REQUEST,
    createDocumentRequestHandler<PropertyRenameParams, PropertyRenamePreviewResult>(
      documents,
      manager,
      suspender,
      {
        uri: (params) => params?.textDocument?.uri ?? '',
        neutral: () => ({
          status: 'failure',
          message: 'The document does not belong to a ready indexed revision.',
        }),
        resolve: async (params, { document, workspace }, cancellation) => {
          if (!validRenameParams(params) || !workspace.previewPropertyRenameAt) {
            return {
              status: 'failure',
              message: 'Safe cross-asset Property Rename is unavailable.',
            };
          }
          return workspace.previewPropertyRenameAt({
            document,
            position: params.position,
            newName: params.newName,
            ...(cancellation ? { cancellation } : {}),
          });
        },
      },
    ),
  );

  connection.onRequest(
    PROPERTY_RENAME_BEGIN_REQUEST,
    createDocumentRequestHandler<PropertyRenameBeginParams, PropertyRenameBeginResult>(
      documents,
      manager,
      suspender,
      {
        uri: (params) => params?.textDocument?.uri ?? '',
        neutral: () => ({
          status: 'failure',
          message: 'The document does not belong to a ready indexed revision.',
        }),
        resolve: async (params, { document, workspace }, cancellation) => {
          if (
            !validRenameParams(params)
            || typeof params.previewId !== 'string'
            || !workspace.beginPropertyRenameAt
          ) {
            return {
              status: 'failure',
              message: 'Safe cross-asset Property Rename is unavailable.',
            };
          }
          return workspace.beginPropertyRenameAt({
            document,
            position: params.position,
            newName: params.newName,
            previewId: params.previewId,
            ...(cancellation ? { cancellation } : {}),
          });
        },
      },
    ),
  );

  connection.onRequest(
    PROPERTY_RENAME_FINISH_REQUEST,
    async (
      params: PropertyRenameFinishParams,
      cancellation: CancellationToken,
    ): Promise<PropertyRenameFinishResult> => {
      throwIfRequestCancelled(cancellation);
      if (
        typeof params?.textDocument?.uri !== 'string'
        || typeof params.transactionId !== 'string'
        || typeof params.sourceApplied !== 'boolean'
      ) {
        return {
          status: 'failed',
          message: 'Rename transaction request is malformed.',
        };
      }
      const workspace = manager.servingWorkspaceFor(params.textDocument.uri);
      if (
        !workspace?.finishPropertyRename
      ) {
        return {
          status: 'failed',
          message: 'Rename transaction is unavailable.',
        };
      }
      return workspace.finishPropertyRename(
        params.transactionId,
        params.sourceApplied,
      );
    },
  );
}
