import type { Connection } from 'vscode-languageserver/node';
import type {
  DiagnosticWorkspaceService,
  IndexedDocumentRegistry,
} from '../workspace/indexedWorkspace';

function sameAttempt(
  left: ReturnType<IndexedDocumentRegistry['snapshot']>,
  right: NonNullable<ReturnType<IndexedDocumentRegistry['snapshot']>>,
): boolean {
  return !!left
    && left.uri === right.uri
    && left.openId === right.openId
    && left.version === right.version
    && left.languageId === right.languageId
    && left.text === right.text;
}

/**
 * Push diagnostics for every current open attempt after each observable index
 * transition. Generation, owner, document identity, and revision checks keep
 * an async result from overwriting a newer publication.
 */
export function registerDiagnosticsPublisher(
  connection: Connection,
  documents: IndexedDocumentRegistry,
  manager: DiagnosticWorkspaceService,
): void {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let draining = false;

  const reportFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    connection.console.error(`[UnityShaderNav] diagnostics publication failed: ${message}`);
  };

  const refreshGeneration = async (generation: number): Promise<void> => {
    const snapshots = [...documents.openSnapshots()];
    await Promise.all(snapshots.map(async (document) => {
      try {
        const workspace = manager.servingWorkspaceFor(document.uri);
        const diagnostics = workspace
          ? await workspace.diagnosticsAt(document)
          : [];
        if (diagnostics === null || generation !== requestedGeneration) return;
        if (!sameAttempt(documents.snapshot(document.uri), document)) return;
        if (manager.servingWorkspaceFor(document.uri) !== workspace) return;
        await connection.sendDiagnostics({
          uri: document.uri,
          version: document.version,
          diagnostics,
        });
      } catch (error) {
        reportFailure(error);
      }
    }));
  };

  const drain = async (): Promise<void> => {
    try {
      while (completedGeneration < requestedGeneration) {
        const generation = requestedGeneration;
        await refreshGeneration(generation);
        completedGeneration = generation;
      }
    } finally {
      draining = false;
      if (completedGeneration < requestedGeneration) scheduleDrain();
    }
  };

  const scheduleDrain = (): void => {
    if (draining) return;
    draining = true;
    queueMicrotask(() => { void drain(); });
  };

  manager.configureDiagnosticsRefresh(() => {
    requestedGeneration++;
    scheduleDrain();
  });
}
