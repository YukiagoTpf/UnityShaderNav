import { describe, expect, it, vi } from 'vitest';
import {
  VARIANT_BUILD_EVIDENCE_CAPABILITY,
  VARIANT_COMPARISON_REQUEST,
  type VariantBuildEvidence,
  type VariantComparisonParams,
  type VariantComparisonReport,
} from '@unity-shader-nav/shared';
import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import { variantSourceHash } from '../../src/adapter/variantComparison';
import { registerVariantComparisonHandler } from '../../src/handlers/variantComparison';

const URI = 'file:///project/Assets/Shaders/Lit.shader';
const SOURCE = [
  'Shader "Tests/Lit" {',
  '  SubShader {',
  '    Pass {',
  '      Name "Forward"',
  '      HLSLPROGRAM',
  '      #pragma fragment Frag',
  '      #pragma multi_compile _ QUALITY_LOW QUALITY_HIGH',
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
].join('\n');

function evidence(): VariantBuildEvidence {
  return {
    status: 'completed',
    provenance: {
      capability: VARIANT_BUILD_EVIDENCE_CAPABILITY,
      projectId: 'project-a',
      instanceId: 'editor-1',
      adapterVersion: '0.3.0',
      unityVersion: '6000.0.31f1',
      buildTarget: 'StandaloneWindows64',
      collectedAt: 1_000_000,
      sourceRevision: {
        uri: URI,
        assetGuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contentHash: variantSourceHash(SOURCE),
      },
    },
    contexts: [{
      shaderName: 'Tests/Lit',
      subShaderIndex: 0,
      passIndex: 0,
      passName: 'Forward',
      stage: 'fragment',
      graphicsApi: 'Direct3D11',
      compileCandidates: { availability: 'available', count: '3' },
      kept: { availability: 'available', count: '1' },
      keywordSets: [{
        keywords: ['QUALITY_LOW', 'QUALITY_HIGH'],
        scope: 'global',
        hasBlankOption: true,
        compileCandidates: { availability: 'available', count: '3' },
        kept: { availability: 'available', count: '1' },
      }],
    }],
  };
}

describe('Variant comparison request', () => {
  it('flows current saved source through the Adapter trust boundary into the report', async () => {
    let handler: ((params: VariantComparisonParams) => Promise<VariantComparisonReport | null>)
      | undefined;
    const connection = {
      onRequest(method: string, callback: typeof handler) {
        expect(method).toBe(VARIANT_COMPARISON_REQUEST);
        handler = callback;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const document = TextDocument.create(URI, 'shaderlab', 1, SOURCE);
    const documents = {
      get: (uri: string) => uri === URI ? document : undefined,
    } as TextDocuments<TextDocument>;
    const getVariantBuildEvidence = vi.fn(async () => evidence());
    const registry = new AdapterRegistry({
      now: () => 1_000_000,
      variantBuildSource: { getVariantBuildEvidence },
    });
    registry.registerHandshake('project-a', {
      interfaceVersion: 1,
      issuedAt: 1_000_000,
      instanceId: 'editor-1',
      capabilities: {
        unityVersion: '6000.0.31f1',
        projectId: 'project-a',
        adapterVersion: '0.3.0',
        supportedFeatures: [VARIANT_BUILD_EVIDENCE_CAPABILITY],
      },
    });

    registerVariantComparisonHandler(connection, documents, registry);
    if (!handler) throw new Error('Variant comparison handler was not registered');
    const report = await handler({ textDocument: { uri: URI } });

    expect(getVariantBuildEvidence).toHaveBeenCalledWith(URI);
    expect(report).toMatchObject({
      currentSource: { uri: URI, contentHash: variantSourceHash(SOURCE) },
      build: { availability: 'available', status: 'completed' },
      comparisons: [{
        declared: { evidenceClass: 'declared', count: '3' },
        compileCandidates: { evidenceClass: 'compile-candidates', count: '3' },
        kept: { evidenceClass: 'kept', count: '1' },
      }],
      largestDeclaredToKeptGaps: [{ gap: '2' }],
    });
  });
});
