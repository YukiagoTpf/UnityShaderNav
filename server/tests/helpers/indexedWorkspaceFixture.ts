import {
  DEFAULT_SETTINGS,
  type FileIndex,
} from '@unity-shader-nav/shared';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { createIncludeChain, type IncludeContext } from '../../src/include';
import { MacroPatternRecognizer } from '../../src/macros';
import type {
  IndexedDocumentRegistry,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';
import {
  navigateDefinition,
  navigateReferences,
} from '../../src/workspace/navigation';
import { unresolvedEntryPointDiagnostics } from '../../src/workspace/diagnostics';
import {
  prepareWorkspaceRename,
  renameWorkspaceSymbol,
} from '../../src/workspace/rename';
import { WorkspaceIndex } from '../../src/workspace/workspaceIndex';
import {
  materialPropertyTargetAt,
  materialPropertyReferences,
} from '../../src/workspace/materialReferences';
import { csharpPropertyReferences } from '../../src/workspace/csharpPropertyReferences';
import type { MaterialUsageProvider } from '../../src/adapter/materialSource';
import type {
  CSharpCurrentSourceProvider,
  CSharpPropertyUsageProvider,
} from '../../src/adapter/csharpPropertySource';

interface NavigationFixtureOptions {
  includeCtx?: IncludeContext;
  includePackages?: boolean;
  isInPackages?: (uri: string) => boolean;
  definitionTrace?: boolean;
  materialUsages?: MaterialUsageProvider;
  csharpPropertyUsages?: CSharpPropertyUsageProvider;
  csharpCurrentSource?: CSharpCurrentSourceProvider;
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
    new MacroPatternRecognizer(DEFAULT_SETTINGS.declarationMacros),
    () => false,
  );
  for (const fileIndex of indexes) index.restoreFromCache(fileIndex.uri, fileIndex);

  const state = () => ({
    index: index.read,
    includeChain: createIncludeChain(
      index.read.store,
      options.includeCtx ?? {
        unityProjectRoot: undefined,
        includeDirectories: [],
      },
    ),
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
    async diagnosticsAt(document) {
      await this.updateDocument(document);
      return unresolvedEntryPointDiagnostics(state(), document.uri);
    },
    async codeActionsAt() { return []; },
    async definitionAt(input) {
      await this.updateDocument(input.document);
      return navigateDefinition(state(), input);
    },
    async referencesAt(input) {
      await this.updateDocument(input.document);
      const sourceLocations = await navigateReferences(state(), input);
      if (!options.materialUsages && !options.csharpPropertyUsages) {
        return sourceLocations;
      }
      const target = materialPropertyTargetAt(
        state().index.store.get(input.document.uri),
        input.position,
      );
      if (!target) return sourceLocations;
      const materialLocations = options.materialUsages
        ? await materialPropertyReferences(
          input.document.uri,
          target,
          options.materialUsages,
          input.cancellation,
        )
        : [];
      const csharpLocations = options.csharpPropertyUsages
        ? await csharpPropertyReferences(
          input.document.uri,
          target,
          options.csharpPropertyUsages,
          options.csharpCurrentSource,
          input.cancellation,
        )
        : [];
      const overlayLocations = [...materialLocations, ...csharpLocations];
      return overlayLocations.length > 0
        ? [...(sourceLocations ?? []), ...overlayLocations]
        : sourceLocations;
    },
    async prepareRenameAt(input) {
      await this.updateDocument(input.document);
      return prepareWorkspaceRename(state(), input);
    },
    async renameAt(input) {
      await this.updateDocument(input.document);
      return renameWorkspaceSymbol(state(), input);
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
