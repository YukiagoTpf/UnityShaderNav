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

// Copied from semanticTokens.ts (private there). `.shader` files only dim inside
// HLSL/CG blocks; everything else is analyzed as a whole HLSL file.
function isShaderLabUri(uri: string): boolean {
  return /\.shader(?:$|[?#])/i.test(uri);
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
    async (params: InactiveRegionsParams): Promise<InactiveRegionsResult> => {
      const { uri, version } = params.textDocument;
      // Echo the requested version in EVERY result so the client can drop stale
      // responses (the custom request gets no built-in version handling).
      const empty: InactiveRegionsResult = { version, regions: [] };

      const resolveRequest = async (): Promise<InactiveRegionsResult> => {
        const settings = await getSettings(uri);
        if (!settings.dimInactiveBranches.enabled) return empty;

        // Text-only path: dimming is purely per-document presentation, so we do
        // not resolve a workspace/index — the analyzer needs only the raw text.
        const text = documents.get(uri)?.getText();
        if (text === undefined) return empty;

        const regions = analyzeInactiveRegions(text, { isShaderLab: isShaderLabUri(uri) });
        return { version, regions };
      };

      if (!suspender) return resolveRequest();
      return await suspender.run(resolveRequest) ?? empty;
    },
  );
}
