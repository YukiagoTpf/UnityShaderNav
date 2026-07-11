export { Workspace } from './workspace';
export type { FileEvent } from './workspaceIndex';
export { WorkspaceManager } from './workspaceManager';
export { snapshotDocument } from './indexedWorkspace';
export type {
  DefinitionAtInput,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
  IndexedWorkspaceService,
  NavigationObserver,
  OpenDocumentsProvider,
  ReferencesAtInput,
} from './indexedWorkspace';
export { detectUnityRoot } from './detectUnityRoot';
export { containsPath, normalizePathForComparison } from './pathUtils';
export { walkFiles } from './walkFiles';
