import { createHash } from 'node:crypto';
import {
  DiagnosticSeverity,
  type Connection,
  type Diagnostic,
} from 'vscode-languageserver/node';
import type {
  AdapterDiagnostic,
  AdapterStatus,
} from '@unity-shader-nav/shared';
import type { AdapterRegistry } from '../adapter/adapterRegistry';
import { uriKey } from '../uriKey';
import type { FileEvent } from '../workspace/workspace';
import type { IndexedDocumentSnapshot } from '../workspace/indexedWorkspace';
import type { RegisteredDocuments } from './documents';
import type { DiagnosticOverlay } from './diagnosticOverlay';

const SUPPORTED_ASSET_URI = /\.(?:shader|compute)(?:$|[?#])/i;

interface SavedAttempt {
  readonly uri: string;
  readonly openId: number;
  readonly version: number;
  readonly contentHash: string;
}

interface PublishedAdapterDiagnostics extends SavedAttempt {
  readonly diagnostics: readonly Diagnostic[];
}

export interface AdapterDiagnosticOverlay extends DiagnosticOverlay {
  handleFileEvent(event: FileEvent): void;
}

export function shaderSourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function sameAttempt(
  document: IndexedDocumentSnapshot | undefined,
  attempt: SavedAttempt,
): boolean {
  return !!document
    && document.openId === attempt.openId
    && document.version === attempt.version
    && shaderSourceHash(document.text) === attempt.contentHash;
}

function adapterDiagnosticToLsp(
  diagnostic: AdapterDiagnostic,
  source: string,
): Diagnostic {
  const { shaderMessage, provenance } = diagnostic;
  const sourceLines = source.split(/\r\n|\r|\n/);
  const reportedLine = shaderMessage.line ?? 1;
  const line = Math.min(
    Math.max(0, Number.isFinite(reportedLine) ? Math.trunc(reportedLine) - 1 : 0),
    Math.max(0, sourceLines.length - 1),
  );
  const platform = shaderMessage.platform
    ? `, ${shaderMessage.platform}`
    : '';
  const details = shaderMessage.messageDetails
    ? `\n${shaderMessage.messageDetails}`
    : '';
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: sourceLines[line]?.length ?? 0 },
    },
    severity: shaderMessage.severity === 'error'
      ? DiagnosticSeverity.Error
      : DiagnosticSeverity.Warning,
    source: `Unity Shader Compiler (Unity ${provenance.unityVersion}${platform})`,
    message: `${shaderMessage.message}${details}`,
    data: {
      kind: 'adapter-diagnostic',
      shaderMessage,
      provenance,
    },
  };
}

/**
 * Maintain compiler-verified diagnostics for the exact saved document attempt.
 * Publication stays centralized in registerDiagnosticsPublisher so Adapter and
 * static diagnostics cannot replace one another at the LSP boundary.
 */
export function registerAdapterDiagnosticOverlay(
  connection: Connection,
  documents: RegisteredDocuments,
  registry: AdapterRegistry,
): AdapterDiagnosticOverlay {
  const savedAttempts = new Map<string, SavedAttempt>();
  const published = new Map<string, PublishedAdapterDiagnostics>();
  const requestGenerations = new Map<string, number>();
  const listeners = new Set<() => void>();

  const reportFailure = (uri: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    connection.console.error(
      `[UnityShaderNav] Adapter diagnostics refresh failed for ${uri}: ${message}`,
    );
  };

  const publishChange = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const invalidate = (key: string): void => {
    requestGenerations.set(key, (requestGenerations.get(key) ?? 0) + 1);
  };

  const clearPublished = (key: string): boolean => published.delete(key);

  const refresh = (document: IndexedDocumentSnapshot): void => {
    if (!SUPPORTED_ASSET_URI.test(document.uri)) return;
    const key = uriKey(document.uri);
    const attempt: SavedAttempt = {
      uri: document.uri,
      openId: document.openId,
      version: document.version,
      contentHash: shaderSourceHash(document.text),
    };
    savedAttempts.set(key, attempt);
    const generation = (requestGenerations.get(key) ?? 0) + 1;
    requestGenerations.set(key, generation);
    if (clearPublished(key)) publishChange();

    void registry.shaderMessagesFor(document.uri, attempt.contentHash)
      .then((adapterDiagnostics) => {
        if (adapterDiagnostics === null) return;
        if (requestGenerations.get(key) !== generation) return;
        const current = documents.snapshot(document.uri);
        const saved = savedAttempts.get(key);
        if (!current || !saved || saved !== attempt || !sameAttempt(current, attempt)) return;
        published.set(key, {
          ...attempt,
          diagnostics: adapterDiagnostics.map((diagnostic) => (
            adapterDiagnosticToLsp(diagnostic, current.text)
          )),
        });
        publishChange();
      })
      .catch((error: unknown) => reportFailure(document.uri, error));
  };

  const clearAttempt = (uri: string, forgetSaved: boolean): void => {
    const key = uriKey(uri);
    invalidate(key);
    if (forgetSaved) savedAttempts.delete(key);
    if (clearPublished(key)) publishChange();
  };

  const handleStatusChange = (status: AdapterStatus): void => {
    if (status.mode === 'standalone') {
      for (const key of new Set([
        ...requestGenerations.keys(),
        ...published.keys(),
      ])) invalidate(key);
      if (published.size > 0) {
        published.clear();
        publishChange();
      }
      return;
    }

    for (const attempt of [...savedAttempts.values()]) {
      const current = documents.snapshot(attempt.uri);
      if (current && sameAttempt(current, attempt)) refresh(current);
    }
  };

  documents.documents.onDidOpen(({ document }) => {
    const snapshot = documents.snapshot(document.uri);
    if (!snapshot || !SUPPORTED_ASSET_URI.test(snapshot.uri)) return;
    savedAttempts.set(uriKey(snapshot.uri), {
      uri: snapshot.uri,
      openId: snapshot.openId,
      version: snapshot.version,
      contentHash: shaderSourceHash(snapshot.text),
    });
  });
  documents.documents.onDidChangeContent(({ document }) => {
    const key = uriKey(document.uri);
    const saved = savedAttempts.get(key);
    if (saved && sameAttempt(documents.snapshot(document.uri), saved)) return;
    clearAttempt(document.uri, true);
  });
  documents.documents.onDidSave(({ document }) => {
    const snapshot = documents.snapshot(document.uri);
    if (snapshot) refresh(snapshot);
  });
  documents.onDidCloseSnapshot((document) => {
    clearAttempt(document.uri, true);
  });
  registry.onDidChangeStatus(handleStatusChange);

  return {
    diagnosticsFor(document) {
      const result = published.get(uriKey(document.uri));
      return result && sameAttempt(document, result) ? result.diagnostics : [];
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    handleFileEvent(event) {
      if (event.type === 'deleted') clearAttempt(event.uri, true);
    },
  };
}
