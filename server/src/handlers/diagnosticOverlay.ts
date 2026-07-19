import type { Diagnostic } from 'vscode-languageserver/node';
import type { IndexedDocumentSnapshot } from '../workspace/indexedWorkspace';

/** Additive diagnostics that participate in the single LSP publication. */
export interface DiagnosticOverlay {
  diagnosticsFor(document: IndexedDocumentSnapshot): readonly Diagnostic[];
  onDidChange(listener: () => void): { dispose(): void };
}
