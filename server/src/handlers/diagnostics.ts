import type { Connection } from 'vscode-languageserver/node';
import type {
  DiagnosticWorkspaceService,
  IndexedDocumentLifecycleRegistry,
  IndexedDocumentRegistry,
} from '../workspace/indexedWorkspace';
import { uriKey } from '../uriKey';

function sameAttempt(
  left: ReturnType<IndexedDocumentRegistry['snapshot']>,
  right: NonNullable<ReturnType<IndexedDocumentRegistry['snapshot']>>,
): boolean {
  return !!left
    && uriKey(left.uri) === uriKey(right.uri)
    && left.openId === right.openId
    && left.version === right.version
    && left.languageId === right.languageId
    && left.text === right.text;
}

/**
 * Push diagnostics for every current open attempt after each observable index
 * transition. Every canonical URI has one ordered send pipeline. Generation,
 * owner, document identity, and revision checks keep an async result from
 * overwriting a newer publication or a closed/reopened session.
 */
export function registerDiagnosticsPublisher(
  connection: Connection,
  documents: IndexedDocumentLifecycleRegistry,
  manager: DiagnosticWorkspaceService,
): void {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let draining = false;
  const pipelines = new Map<string, {
    generation: number;
    tail: Promise<void>;
  }>();

  const reportFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    connection.console.error(`[UnityShaderNav] diagnostics publication failed: ${message}`);
  };

  const enqueueSend = (
    uri: string,
    isCurrent: () => boolean,
    send: () => Promise<void>,
  ): Promise<void> => {
    const key = uriKey(uri);
    const pipeline = pipelines.get(key) ?? {
      generation: 0,
      tail: Promise.resolve(),
    };
    pipelines.set(key, pipeline);
    const generation = ++pipeline.generation;
    const operation = pipeline.tail.then(async () => {
      try {
        if (pipeline.generation !== generation || !isCurrent()) return;
        await send();
      } catch (error) {
        reportFailure(error);
      }
    });
    pipeline.tail = operation;
    void operation.then(() => {
      if (pipeline.tail === operation) pipelines.delete(key);
    });
    return operation;
  };

  const refreshGeneration = async (generation: number): Promise<void> => {
    const snapshots = [...documents.openSnapshots()];
    await Promise.all(snapshots.map(async (document) => {
      try {
        const workspace = manager.servingWorkspaceFor(document.uri);
        const diagnostics = workspace
          ? await workspace.diagnosticsAt(document)
          : [];
        // Reject stale computation before enqueueing: advancing this URI's
        // generation would otherwise cancel a close clear already waiting in
        // the pipeline. The same facts are rechecked after the queue wait.
        if (diagnostics === null || generation !== requestedGeneration) return;
        if (!sameAttempt(documents.snapshot(document.uri), document)) return;
        if (manager.servingWorkspaceFor(document.uri) !== workspace) return;
        await enqueueSend(
          document.uri,
          () => (
            generation === requestedGeneration
            && sameAttempt(documents.snapshot(document.uri), document)
            && manager.servingWorkspaceFor(document.uri) === workspace
          ),
          async () => connection.sendDiagnostics({
            uri: document.uri,
            version: document.version,
            diagnostics,
          }),
        );
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

  documents.onDidCloseSnapshot((document) => {
    void enqueueSend(
      document.uri,
      () => documents.snapshot(document.uri) === undefined,
      async () => connection.sendDiagnostics({
        uri: document.uri,
        diagnostics: [],
      }),
    );
  });

  manager.configureDiagnosticsRefresh(() => {
    requestedGeneration++;
    scheduleDrain();
  });
}
