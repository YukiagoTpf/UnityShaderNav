import type { Connection } from 'vscode-languageserver/node';
import {
  PASS_EXPLANATION_REQUEST,
  type PassExplanationAnswer,
  type PassExplanationParams,
} from '@unity-shader-nav/shared';
import type { PassExplanationService } from '../explanation';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { createRequestHandler } from './documentRequest';

/** Register the local, pull-only Pass explanation request. */
export function registerPassExplanationHandler(
  connection: Connection,
  service: PassExplanationService,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onRequest(
    PASS_EXPLANATION_REQUEST,
    createRequestHandler<PassExplanationParams, PassExplanationAnswer>(
      suspender,
      {
        neutral: (params) => service.neutral(params.textDocument.uri),
        resolve: (params, cancellation) => (
          service.explain(params.textDocument.uri, cancellation)
        ),
      },
    ),
  );
}
