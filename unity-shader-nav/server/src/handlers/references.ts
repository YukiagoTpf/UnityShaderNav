import type {
  Connection,
  Location,
  ReferenceParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'node:url';
import type {
  Range,
} from '@unity-shader-nav/shared';
import {
  collectVisibleUriKeys,
  resolveReferenceTargets,
  resolveReferenceTargetsForName,
  resolveReferenceTargetsForMemberReference,
  wordAt,
} from '../index';
import { resolveInclude } from '../include';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { scanIncludes } from '../parser/include/lineScanner';
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

function includePathContainsPosition(range: Range, position: Range['start']): boolean {
  return position.line === range.start.line
    && position.character >= range.start.character
    && position.character <= range.end.character;
}

export function registerReferencesHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onReferences(async (params: ReferenceParams): Promise<Location[] | null> => {
    const resolveRequest = async (): Promise<Location[] | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      const fullText = document.getText();
      const include = scanIncludes(fullText).find((candidate) =>
        includePathContainsPosition(candidate.pathRange, params.position),
      );
      if (include) {
        const resolved = await resolveInclude(
          include.path,
          params.textDocument.uri,
          workspace.includeCtx,
        );
        if (!resolved) return null;

        const targetUri = pathToFileURL(resolved.absolutePath).href;
        const includePackages = workspace.settings.findReferences.includePackages;
        const locations: Location[] = [];

        for (const uri of workspace.store.uris()) {
          const index = workspace.store.get(uri);
          if (!index) continue;

          for (const reference of index.references) {
            if (reference.context !== 'include') continue;
            if (!includePackages && workspace.isInPackages(reference.location.uri)) continue;

            const candidate = await resolveInclude(
              reference.name,
              reference.location.uri,
              workspace.includeCtx,
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

      const word = wordAt(fullText, params.position);
      if (!word) return null;

      const idx = workspace.store?.get(params.textDocument.uri);
      const visibleByUri = new Map<string, Promise<Set<string>>>();
      const visibleForUri = (uri: string): Promise<Set<string>> => {
        const existing = visibleByUri.get(uri);
        if (existing) return existing;

        const next = collectVisibleUriKeys(workspace.store, workspace.includeCtx, uri);
        visibleByUri.set(uri, next);
        return next;
      };
      const visibleUriKeys = idx ? await visibleForUri(params.textDocument.uri) : undefined;
      const resolutionOptions = visibleUriKeys ? { visibleUriKeys } : undefined;
      const targets = idx
        ? resolveReferenceTargets(idx, fullText, params.position, workspace.global, resolutionOptions)
        : [];
      const scopedTargets = targets.filter(isScopedTarget);
      const memberTargets = targets.filter(isMemberTarget);
      const narrowedTargets = [...scopedTargets, ...memberTargets];
      const queryName = targets[0]?.name ?? word.text;
      const globalKindAwareTargets = narrowedTargets.length === 0
        ? narrowGlobalTargetsForOccurrence(
          targets.filter(isGlobalKindAwareTarget),
          idx,
          queryName,
          params.position,
        )
        : [];
      const activeTargets = narrowedTargets.length > 0 ? narrowedTargets : globalKindAwareTargets;
      const includePackages = workspace.settings.findReferences.includePackages;
      const symbolsAsReferences = params.context.includeDeclaration
        ? workspace.global
          .lookup(queryName)
          .filter((symbol) => includePackages || !workspace.isInPackages(symbol.location.uri))
          .filter((symbol) =>
            activeTargets.length === 0 ||
            activeTargets.some((target) => sameTarget(target, symbolToTarget(symbol))))
          .map((symbol) => ({
            uri: symbol.location.uri,
            range: symbol.location.range,
          }))
        : [];

      const references: Location[] = [];
      for (const reference of workspace.globalRefs.lookup(queryName)) {
        if (!includePackages && workspace.isInPackages(reference.location.uri)) continue;

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

        const candidateIndex = workspace.store?.get(reference.location.uri);
        if (!candidateIndex) continue;

        const candidateVisibleUriKeys = await visibleForUri(reference.location.uri);
        const candidateResolutionOptions = { visibleUriKeys: candidateVisibleUriKeys };
        const candidateTargets = reference.context === 'member'
          ? resolveReferenceTargetsForMemberReference(
            candidateIndex,
            reference,
            workspace.global,
            candidateResolutionOptions,
          )
          : reference.context !== 'include'
            ? resolveReferenceTargetsForName(
              candidateIndex,
              reference.name,
              reference.location.range.start,
              workspace.global,
              candidateResolutionOptions,
            )
            : [];

        if (
          candidateTargets.some((candidate) =>
            activeTargets.some((target) => sameTarget(candidate, target)),
          )
        ) {
          references.push({ uri: reference.location.uri, range: reference.location.range });
        }
      }

      return uniqueLocations([...symbolsAsReferences, ...references]);
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
