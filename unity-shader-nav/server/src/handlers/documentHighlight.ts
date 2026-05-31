import type {
  Connection,
  DocumentHighlight,
  DocumentHighlightParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import { DocumentHighlightKind } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Location } from 'vscode-languageserver';
import { cursorTargetAt, findHighlights } from '../index';
import { resolveRequestContext } from './requestContext';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import type { WorkspaceManager } from '../workspace';

function toHighlight(location: Location): DocumentHighlight {
  return {
    range: location.range,
    kind: DocumentHighlightKind.Text,
  };
}

export function registerDocumentHighlightHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentHighlight(async (params: DocumentHighlightParams): Promise<DocumentHighlight[] | null> => {
    const resolveRequest = async (): Promise<DocumentHighlight[] | null> => {
      const ctx = await resolveRequestContext(params.textDocument.uri, documents, manager);
      if (!ctx) return null;
      const document = ctx.doc;

      const index = await ctx.index();
      if (!index) return null;

      const fullText = document.getText();
      if (!isGenericDefinitionContext(
        fullText,
        params.position,
        document.languageId,
        params.textDocument.uri,
      )) {
        return null;
      }

      // Probe cheap token state BEFORE collecting visible URIs so the early
      // exit precedes the include-visibility walk. detectIncludes:false because
      // documentHighlight never navigates includes and the gate already excludes
      // include-path positions (they are lexically strings).
      const target = cursorTargetAt(fullText, params.position, { detectIncludes: false });
      if (target.kind === 'none') return null;

      const visibleUriKeys = await ctx.visibleUriKeys();
      const highlights = findHighlights(target, {
        index,
        position: params.position,
        global: ctx.global,
        options: { visibleUriKeys },
      }).map(toHighlight);
      return highlights.length > 0 ? highlights : null;
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
