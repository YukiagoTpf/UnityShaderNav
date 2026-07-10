import type {
  Connection,
  Location,
  ReferenceParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'node:url';
import {
  cursorTargetAt,
  findReferences,
  uniqueLocations,
} from '../index';
import { resolveInclude } from '../include';
import { resolveRequestContext } from './requestContext';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';

export function registerReferencesHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onReferences(async (params: ReferenceParams): Promise<Location[] | null> => {
    const resolveRequest = async (): Promise<Location[] | null> => {
      const ctx = await resolveRequestContext(params.textDocument.uri, documents, manager);
      if (!ctx) return null;
      const document = ctx.doc;
      const workspace = ctx.workspace;

      const fullText = document.getText();
      const target = cursorTargetAt(fullText, params.position);
      if (target.kind === 'include') {
        const resolved = await resolveInclude(
          target.include.path,
          params.textDocument.uri,
          ctx.includeCtx,
        );
        if (!resolved) return null;

        const targetUri = pathToFileURL(resolved.absolutePath).href;
        const includePackages = workspace.settings.findReferences.includePackages;
        const locations: Location[] = [];

        for (const uri of ctx.store.uris()) {
          const index = ctx.store.get(uri);
          if (!index) continue;

          for (const reference of index.references) {
            if (reference.context !== 'include') continue;
            if (!includePackages && workspace.packages.isInPackages(reference.location.uri)) continue;

            const candidate = await resolveInclude(
              reference.name,
              reference.location.uri,
              ctx.includeCtx,
            );
            if (!candidate) continue;
            if (pathToFileURL(candidate.absolutePath).href !== targetUri) continue;

            locations.push({
              uri: reference.location.uri,
              range: reference.location.range,
            });
          }
        }

        return uniqueLocations(locations);
      }

      if (target.kind === 'none') return null;

      return findReferences(target, {
        index: ctx.store?.get(params.textDocument.uri),
        position: params.position,
        global: ctx.global,
        globalRefs: ctx.globalRefs,
        store: ctx.store,
        includeCtx: ctx.includeCtx,
        isInPackages: (u) => workspace.packages.isInPackages(u),
        includePackages: workspace.settings.findReferences.includePackages,
        includeDeclaration: params.context.includeDeclaration,
      });
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
