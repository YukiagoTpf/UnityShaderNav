import {
  DiagnosticSeverity,
  type Diagnostic,
} from 'vscode-languageserver/node';
import type { IncludeChain } from '../include';
import {
  resolveDefinitionSymbols,
  type GlobalSymbolReader,
  type IndexStoreReader,
} from '../index';

export const UNRESOLVED_ENTRY_POINT_CODE = 'unresolved-entry-point';
export const DIAGNOSTIC_SOURCE = 'UnityShaderNav';

export interface WorkspaceDiagnosticState {
  readonly index: {
    readonly store: IndexStoreReader;
    readonly global: GlobalSymbolReader;
  };
  readonly includeChain: IncludeChain;
}

/**
 * Report only declaration-backed entry-point failures. Any visible function or
 * macro candidate suppresses the diagnostic because overloads, preprocessor
 * branches, and macro expansion are intentionally not compiled here.
 */
export async function unresolvedEntryPointDiagnostics(
  state: WorkspaceDiagnosticState,
  uri: string,
): Promise<Diagnostic[]> {
  const index = state.index.store.get(uri);
  if (!index) return [];
  const pragmas = index.references.filter((reference) => reference.context === 'pragma');
  if (pragmas.length === 0) return [];

  const visibleUriKeys = await state.includeChain.visibleUriKeys(uri);
  const diagnostics: Diagnostic[] = [];
  for (const reference of pragmas) {
    const candidates = resolveDefinitionSymbols(
      index,
      reference.name,
      reference.location.range.start,
      state.index.global,
      { visibleUriKeys },
    );
    if (candidates.some((candidate) => (
      candidate.kind === 'function' || candidate.kind === 'macro'
    ))) continue;
    diagnostics.push({
      range: reference.location.range,
      severity: DiagnosticSeverity.Error,
      code: UNRESOLVED_ENTRY_POINT_CODE,
      source: DIAGNOSTIC_SOURCE,
      message: `No visible function declaration resolves entry point '${reference.name}'.`,
    });
  }
  return diagnostics;
}
