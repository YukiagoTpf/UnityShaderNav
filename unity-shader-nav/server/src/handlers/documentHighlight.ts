import type {
  Connection,
  DocumentHighlight,
  DocumentHighlightParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import { DocumentHighlightKind } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Location } from 'vscode-languageserver';
import {
  collectVisibleUriKeys,
  resolveReferenceTargets,
  resolveReferenceTargetsForMemberReference,
  resolveReferenceTargetsForName,
  wordAt,
} from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import type { WorkspaceManager } from '../workspace';
import {
  isGlobalKindAwareTarget,
  isMemberTarget,
  isReferenceContextCompatible,
  isScopedTarget,
  narrowGlobalTargetsForOccurrence,
  sameTarget,
  symbolToTarget,
  uniqueLocations,
} from './referenceMatching';

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
      const document = documents.get(params.textDocument.uri);
      if (!document) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      let index = workspace.store.get(params.textDocument.uri);
      if (!index && typeof workspace.reindex === 'function') {
        await workspace.reindex(document.uri, document.getText());
        index = workspace.store.get(params.textDocument.uri);
      }
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

      const word = wordAt(fullText, params.position);
      if (!word) return null;

      const visibleUriKeys = await collectVisibleUriKeys(
        workspace.store,
        workspace.includeCtx,
        params.textDocument.uri,
      );
      const resolutionOptions = { visibleUriKeys };
      const targets = resolveReferenceTargets(
        index,
        fullText,
        params.position,
        workspace.global,
        resolutionOptions,
      );
      const scopedTargets = targets.filter(isScopedTarget);
      const memberTargets = targets.filter(isMemberTarget);
      const narrowedTargets = [...scopedTargets, ...memberTargets];
      const queryName = targets[0]?.name ?? word.text;
      const globalKindAwareTargets = narrowedTargets.length === 0
        ? narrowGlobalTargetsForOccurrence(
          targets.filter(isGlobalKindAwareTarget),
          index,
          queryName,
          params.position,
        )
        : [];
      const activeTargets = narrowedTargets.length > 0 ? narrowedTargets : globalKindAwareTargets;

      const declarations: Location[] = workspace.global
        .lookup(queryName)
        .filter((symbol) => symbol.location.uri === params.textDocument.uri)
        .filter((symbol) =>
          activeTargets.length === 0 ||
          activeTargets.some((target) => sameTarget(target, symbolToTarget(symbol))),
        )
        .map((symbol) => ({
          uri: symbol.location.uri,
          range: symbol.location.range,
        }));

      const references: Location[] = [];
      for (const reference of index.references) {
        if (reference.name !== queryName) continue;
        if (reference.context === 'include') continue;

        if (activeTargets.length === 0) {
          references.push({ uri: reference.location.uri, range: reference.location.range });
          continue;
        }

        if (
          globalKindAwareTargets.length > 0 &&
          !globalKindAwareTargets.some((target) =>
            isReferenceContextCompatible(target, reference.context),
          )
        ) {
          continue;
        }

        const candidateTargets = reference.context === 'member'
          ? resolveReferenceTargetsForMemberReference(
            index,
            reference,
            workspace.global,
            resolutionOptions,
          )
          : resolveReferenceTargetsForName(
            index,
            reference.name,
            reference.location.range.start,
            workspace.global,
            resolutionOptions,
          );

        if (
          candidateTargets.some((candidate) =>
            activeTargets.some((target) => sameTarget(candidate, target)),
          )
        ) {
          references.push({ uri: reference.location.uri, range: reference.location.range });
        }
      }

      const highlights = uniqueLocations([...declarations, ...references]).map(toHighlight);
      return highlights.length > 0 ? highlights : null;
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
