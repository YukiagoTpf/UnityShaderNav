import { describe, expect, it } from 'vitest';
import {
  OPEN_VARIANT_COST_DOCUMENTATION_COMMAND,
} from '@unity-shader-nav/shared';
import type {
  CodeLens,
  CodeLensParams,
  Connection,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { registerCodeLensHandler } from '../../src/handlers/codeLens';

type CodeLensHandler = (params: CodeLensParams) => CodeLens[];

function fakeConnection(): { connection: Connection; getHandler: () => CodeLensHandler } {
  let handler: CodeLensHandler | undefined;
  const connection = {
    onCodeLens(fn: CodeLensHandler) {
      handler = fn;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return {
    connection,
    getHandler: () => {
      if (!handler) throw new Error('CodeLens handler was not registered');
      return handler;
    },
  };
}

function mutableDocuments(uri: string, languageId: string, text: string): {
  documents: TextDocuments<TextDocument>;
  replace: (nextText: string) => void;
} {
  let version = 1;
  let document = TextDocument.create(uri, languageId, version, text);
  return {
    documents: {
      get(requestedUri: string) {
        return requestedUri === uri ? document : undefined;
      },
    } as TextDocuments<TextDocument>,
    replace(nextText: string) {
      document = TextDocument.create(uri, languageId, ++version, nextText);
    },
  };
}

function titles(lenses: readonly CodeLens[]): string[] {
  return lenses.map((lens) => lens.command?.title ?? '');
}

describe('registerCodeLensHandler', () => {
  it('shows per-set contribution plus the document program summary', () => {
    const uri = 'file:///t/variants.compute';
    const text = [
      '#pragma multi_compile _ QUALITY_LOW QUALITY_HIGH',
      '#pragma shader_feature_local_fragment FOG_ON',
    ].join('\n');
    const registry = mutableDocuments(uri, 'hlsl', text);
    const { connection, getHandler } = fakeConnection();
    registerCodeLensHandler(connection, registry.documents);

    const lenses = getHandler()({ textDocument: { uri } });
    expect(titles(lenses)).toEqual([
      'Declared/static program upper bound: 6 variants · 2 unique sets · largest ×3 · why build counts differ',
      'Declared/static set ×3 · scope global/all stages · program upper bound 6 · why build counts differ',
      'Declared/static set ×2 · scope local/fragment · program upper bound 6 · why build counts differ',
    ]);
    expect(lenses.map((lens) => lens.command?.command))
      .toEqual(Array(3).fill(OPEN_VARIANT_COST_DOCUMENTATION_COMMAND));
    expect(lenses.map((lens) => lens.range.start.line)).toEqual([0, 0, 1]);
  });

  it('shows shared include contribution across matching ShaderLab programs', () => {
    const uri = 'file:///t/shared.shader';
    const text = [
      'Shader "Shared" {',
      'HLSLINCLUDE',
      '#pragma multi_compile _ SHARED',
      'ENDHLSL',
      'SubShader {',
      'Pass {',
      'HLSLPROGRAM',
      '#pragma multi_compile LOW HIGH',
      'ENDHLSL',
      '}',
      'Pass {',
      'HLSLPROGRAM',
      'ENDHLSL',
      '}',
      '}',
      '}',
    ].join('\n');
    const registry = mutableDocuments(uri, 'shaderlab', text);
    const { connection, getHandler } = fakeConnection();
    registerCodeLensHandler(connection, registry.documents);

    const resultTitles = titles(getHandler()({ textDocument: { uri } }));
    expect(resultTitles).toContain(
      'Declared/static set ×2 · scope global/all stages · shared by 2 programs · program upper bounds 2–4 · why build counts differ',
    );
    expect(resultTitles.filter((title) => title.startsWith('Declared/static program upper bound:')))
      .toHaveLength(2);
  });

  it('reads the current open document on every request after a live edit', () => {
    const uri = 'file:///t/live.hlsl';
    const registry = mutableDocuments(uri, 'hlsl', '#pragma multi_compile A B');
    const { connection, getHandler } = fakeConnection();
    registerCodeLensHandler(connection, registry.documents);
    const handler = getHandler();

    expect(titles(handler({ textDocument: { uri } }))[0])
      .toContain('program upper bound: 2 variants');
    registry.replace([
      '#pragma multi_compile A B',
      '#pragma shader_feature C D',
    ].join('\n'));
    const updated = titles(handler({ textDocument: { uri } }));
    expect(updated[0]).toContain('program upper bound: 4 variants');
    expect(updated).toHaveLength(3);
  });

  it('returns no lenses when the document is not open', () => {
    const registry = mutableDocuments('file:///t/open.hlsl', 'hlsl', '#pragma multi_compile A B');
    const { connection, getHandler } = fakeConnection();
    registerCodeLensHandler(connection, registry.documents);

    expect(getHandler()({ textDocument: { uri: 'file:///t/missing.hlsl' } })).toEqual([]);
  });
});
