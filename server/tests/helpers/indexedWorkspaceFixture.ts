import {
  DEFAULT_SETTINGS,
  type FileIndex,
} from '@unity-shader-nav/shared';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { IncludeContext } from '../../src/include';
import { MacroPatternTable } from '../../src/macros';
import type {
  IndexedDocumentRegistry,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';
import {
  navigateDefinition,
  navigateReferences,
} from '../../src/workspace/navigation';
import { WorkspaceIndex } from '../../src/workspace/workspaceIndex';

interface NavigationFixtureOptions {
  includeCtx?: IncludeContext;
  includePackages?: boolean;
  isInPackages?: (uri: string) => boolean;
  definitionTrace?: boolean;
}

/**
 * Behavior-level fixture for navigation semantics. Tests seed immutable
 * FileIndexes, while handlers receive only the same IndexedWorkspace behavior
 * used in production; mutable stores never escape this helper.
 */
export function createIndexedWorkspaceFixture(
  indexes: readonly FileIndex[],
  options: NavigationFixtureOptions = {},
): IndexedWorkspace {
  const index = new WorkspaceIndex(
    new MacroPatternTable(DEFAULT_SETTINGS.declarationMacros),
    () => false,
  );
  for (const fileIndex of indexes) index.restoreFromCache(fileIndex.uri, fileIndex);

  const state = () => ({
    index: index.read,
    includeCtx: options.includeCtx ?? {
      unityProjectRoot: undefined,
      includeDirectories: [],
    },
    isInPackages: options.isInPackages ?? (() => false),
    includePackages: options.includePackages ?? false,
    definitionTrace: options.definitionTrace ?? false,
  });

  return {
    async updateDocument(document) {
      if (!index.file(document.uri)) {
        const candidate = await index.prepareDocument(document.uri, document.text);
        if (candidate) index.commitDocument(candidate);
      }
      return true;
    },
    async closeDocument({ uri }) {
      await index.restoreClosedDocument(uri);
    },
    async definitionAt(input) {
      await this.updateDocument(input.document);
      return navigateDefinition(state(), input);
    },
    async referencesAt(input) {
      await this.updateDocument(input.document);
      return navigateReferences(state(), input);
    },
    async hoverAt() { return null; },
    async completionAt() { return null; },
    async signatureHelpAt() { return null; },
    async highlightsAt() { return null; },
    async documentSymbols() { return null; },
    async semanticTokens() { return { data: [] }; },
    workspaceSymbols() { return []; },
  };
}

export function createDocumentRegistry(
  ...documents: readonly TextDocument[]
): IndexedDocumentRegistry {
  const byUri = new Map(documents.map((document, index) => [
    document.uri,
    { document, openId: index + 1 },
  ]));
  const snapshot = (uri: string): IndexedDocumentSnapshot | undefined => {
    const current = byUri.get(uri);
    if (!current) return undefined;
    return {
      uri,
      languageId: current.document.languageId,
      text: current.document.getText(),
      openId: current.openId,
      version: current.document.version,
    };
  };
  return {
    snapshot,
    openSnapshots: () => [...byUri.keys()]
      .map(snapshot)
      .filter((item): item is IndexedDocumentSnapshot => item !== undefined),
  };
}
