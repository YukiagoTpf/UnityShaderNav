import type { Connection } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { TextDocuments } from 'vscode-languageserver/node';
import {
  GET_VARIANT_KEYWORDS_REQUEST,
  type GetVariantKeywordsParams,
  type GetVariantKeywordsResult,
} from '@unity-shader-nav/shared';
import { scanVariantKeywords } from '../parser/preproc/scanVariantKeywords';

export function registerVariantKeywordsHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
): void {
  connection.onRequest(
    GET_VARIANT_KEYWORDS_REQUEST,
    (params: GetVariantKeywordsParams): GetVariantKeywordsResult => {
      const text = documents.get(params.textDocument.uri)?.getText() ?? '';
      return { keywords: [...scanVariantKeywords(text)] };
    },
  );
}
