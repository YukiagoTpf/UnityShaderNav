import {
  VARIANT_COMPARISON_REQUEST,
  type VariantComparisonParams,
  type VariantComparisonReport,
} from '@unity-shader-nav/shared';
import type {
  CancellationToken,
  Connection,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { AdapterRegistry } from '../adapter/adapterRegistry';
import {
  createVariantComparisonReport,
  variantSourceHash,
} from '../adapter/variantComparison';
import { throwIfRequestCancelled } from '../lifecycle/requestCancellation';

export function registerVariantComparisonHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  registry: AdapterRegistry,
): void {
  connection.onRequest(
    VARIANT_COMPARISON_REQUEST,
    async (
      params: VariantComparisonParams,
      cancellation: CancellationToken,
    ): Promise<VariantComparisonReport | null> => {
      throwIfRequestCancelled(cancellation);
      const document = documents.get(params.textDocument.uri);
      if (!document) return null;
      const text = document.getText();
      const evidence = await registry.variantBuildEvidenceFor(
        params.textDocument.uri,
        variantSourceHash(text),
      );
      throwIfRequestCancelled(cancellation);
      return createVariantComparisonReport(params.textDocument.uri, text, evidence);
    },
  );
}
