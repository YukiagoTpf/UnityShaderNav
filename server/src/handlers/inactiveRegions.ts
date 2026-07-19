import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  INACTIVE_REGIONS_REQUEST,
  type ExtensionSettings,
  type InactiveRegionsParams,
  type InactiveRegionsResult,
} from '@unity-shader-nav/shared';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';
import { analyzeInactiveRegions } from '../parser/preproc/analyzeInactiveRegions';
import { isShaderLabUri } from '../sourceLocation';
import { variantContextStore } from '../workspace/variantContextStore';
import { createRequestHandler } from './documentRequest';

function neutralResult(params: InactiveRegionsParams): InactiveRegionsResult {
  return { version: params.textDocument.version, regions: [] };
}

export function registerInactiveRegionsHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  // Accepted for call-site parity with the other register*Handler helpers; the
  // text-only path needs no workspace/index lookup, so it is intentionally unused.
  _manager: WorkspaceManager,
  getSettings: (uri: string) => Promise<ExtensionSettings>,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onRequest(
    INACTIVE_REGIONS_REQUEST,
    createRequestHandler<InactiveRegionsParams, InactiveRegionsResult>(suspender, {
      neutral: neutralResult,
      resolve: async (params) => {
        const { uri, version } = params.textDocument;
        // Echo the requested version in EVERY result so the client can drop stale
        // responses (the custom request gets no built-in version handling).
        const empty = neutralResult(params);
        const settings = await getSettings(uri);
        if (!settings.dimInactiveBranches.enabled) return empty;

        // Text-only path: dimming is purely per-document presentation, so we do
        // not resolve a workspace/index — the analyzer needs only the raw text.
        const text = documents.get(uri)?.getText();
        if (text === undefined) return empty;

        const context = variantContextStore.get(uri);
        const regions = analyzeInactiveRegions(text, {
          isShaderLab: isShaderLabUri(uri),
          context: context ?? undefined,
        });
        return { version, regions };
      },
    }),
  );
}
