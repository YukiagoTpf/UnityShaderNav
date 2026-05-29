import type {
  FileIndex,
  Position,
} from '@unity-shader-nav/shared';
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
  cursorTargetAt,
  isGlobalKindAwareTarget,
  isMemberTarget,
  isReferenceContextCompatible,
  isScopedTarget,
  narrowGlobalTargetsForOccurrence,
  resolveMemberSymbols,
  resolveReferenceTargets,
  resolveReferenceTargetsForMemberReference,
  resolveReferenceTargetsForName,
  sameTarget,
  symbolToTarget,
  uniqueLocations,
} from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import type { WorkspaceManager } from '../workspace';

function isSimpleIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isVariableReceiverTarget(target: ReturnType<typeof resolveReferenceTargetsForName>[number]): boolean {
  return target.kind === 'localVariable' || target.kind === 'parameter' || target.kind === 'variable';
}

function toHighlight(location: Location): DocumentHighlight {
  return {
    range: location.range,
    kind: DocumentHighlightKind.Text,
  };
}

function receiverTargets(
  index: FileIndex,
  receiver: string,
  position: Position,
  global: Parameters<typeof resolveReferenceTargetsForName>[3],
  resolutionOptions: Parameters<typeof resolveReferenceTargetsForName>[4],
) {
  if (!isSimpleIdentifier(receiver)) return [];
  return resolveReferenceTargetsForName(
    index,
    receiver,
    position,
    global,
    resolutionOptions,
  ).filter(isVariableReceiverTarget);
}

function sameReceiverMemberLocations(
  index: FileIndex,
  memberName: string,
  receiverName: string,
  receiverPosition: Position,
  global: Parameters<typeof resolveReferenceTargetsForName>[3],
  resolutionOptions: Parameters<typeof resolveReferenceTargetsForName>[4],
): Location[] {
  const activeReceiverTargets = receiverTargets(
    index,
    receiverName,
    receiverPosition,
    global,
    resolutionOptions,
  );
  if (activeReceiverTargets.length === 0) return [];

  const locations: Location[] = [];
  for (const reference of index.references) {
    if (
      reference.name !== memberName ||
      reference.context !== 'member' ||
      !reference.receiver ||
      !isSimpleIdentifier(reference.receiver)
    ) {
      continue;
    }

    const candidateReceiverTargets = receiverTargets(
      index,
      reference.receiver,
      reference.location.range.start,
      global,
      resolutionOptions,
    );
    if (
      candidateReceiverTargets.some((candidate) =>
        activeReceiverTargets.some((target) => sameTarget(candidate, target)),
      )
    ) {
      locations.push({
        uri: reference.location.uri,
        range: reference.location.range,
      });
    }
  }

  return locations;
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

      // Probe cheap token state BEFORE collecting visible URIs so the early
      // exit precedes the include-visibility walk. detectIncludes:false because
      // documentHighlight never navigates includes and the gate already excludes
      // include-path positions (they are lexically strings).
      const target = cursorTargetAt(fullText, params.position, { detectIncludes: false });
      if (target.kind === 'none') return null;

      const visibleUriKeys = await collectVisibleUriKeys(
        workspace.store,
        workspace.includeCtx,
        params.textDocument.uri,
      );
      const resolutionOptions = { visibleUriKeys };
      const targets = target.kind === 'member'
        ? resolveMemberSymbols(
          index,
          workspace.global,
          target.receiver.text,
          target.member.text,
          params.position,
          resolutionOptions,
        ).map(symbolToTarget)
        : resolveReferenceTargets(
          index,
          fullText,
          params.position,
          workspace.global,
          resolutionOptions,
        );
      if (target.kind === 'member' && targets.length === 0) {
        const fallbackHighlights = sameReceiverMemberLocations(
          index,
          target.member.text,
          target.receiver.text,
          target.receiver.range.start,
          workspace.global,
          resolutionOptions,
        ).map(toHighlight);
        return fallbackHighlights.length > 0 ? fallbackHighlights : null;
      }
      const scopedTargets = targets.filter(isScopedTarget);
      const memberTargets = targets.filter(isMemberTarget);
      const narrowedTargets = [...scopedTargets, ...memberTargets];
      // 'include' cannot occur with detectIncludes:false; treat any
      // non-member/symbol as null to satisfy the static union narrowing.
      if (target.kind !== 'member' && target.kind !== 'symbol') return null;
      const queryName = targets[0]?.name ?? (target.kind === 'member' ? target.member.text : target.word.text);
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
