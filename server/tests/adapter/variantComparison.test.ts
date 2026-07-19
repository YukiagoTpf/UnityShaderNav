import { describe, expect, it } from 'vitest';
import {
  VARIANT_BUILD_EVIDENCE_CAPABILITY,
  type VariantBuildEvidenceResult,
} from '@unity-shader-nav/shared';
import { createVariantComparisonReport } from '../../src/adapter/variantComparison';

const URI = 'file:///project/Assets/Shaders/Lit.shader';
const SOURCE = [
  'Shader "Tests/Lit" {',
  '  SubShader {',
  '    Pass {',
  '      Name "Forward"',
  '      HLSLPROGRAM',
  '      #pragma vertex Vert',
  '      #pragma fragment Frag',
  '      #pragma multi_compile _ QUALITY_LOW QUALITY_HIGH QUALITY_ULTRA',
  '      #pragma shader_feature_local_fragment _ NORMAL_MAP DETAIL_MAP',
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
].join('\n');

function buildEvidence(): VariantBuildEvidenceResult {
  const provenance = {
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
      contentHash: 'fixture-hash',
    },
  } as const;
  const globalSet = {
    keywords: ['QUALITY_LOW', 'QUALITY_HIGH', 'QUALITY_ULTRA'],
    scope: 'global' as const,
    hasBlankOption: true,
    compileCandidates: { availability: 'available' as const, count: '4' },
    kept: { availability: 'available' as const, count: '1' },
  };
  const unstrippedVertexSet = {
    ...globalSet,
    kept: { availability: 'available' as const, count: '4' },
  };
  return {
    availability: 'available',
    evidence: {
      status: 'completed',
      provenance,
      contexts: [
        {
          shaderName: 'Tests/Lit',
          subShaderIndex: 0,
          passIndex: 0,
          passName: 'Forward',
          stage: 'vertex',
          graphicsApi: 'Direct3D11',
          compileCandidates: { availability: 'available', count: '4' },
          kept: { availability: 'available', count: '4' },
          keywordSets: [unstrippedVertexSet],
        },
        {
          shaderName: 'Tests/Lit',
          subShaderIndex: 0,
          passIndex: 0,
          passName: 'Forward',
          stage: 'fragment',
          graphicsApi: 'Direct3D11',
          compileCandidates: { availability: 'available', count: '12' },
          kept: { availability: 'available', count: '2' },
          keywordSets: [
            globalSet,
            {
              keywords: ['NORMAL_MAP', 'DETAIL_MAP'],
              scope: 'local',
              stage: 'fragment',
              hasBlankOption: true,
              compileCandidates: { availability: 'available', count: '3' },
              kept: { availability: 'available', count: '2' },
            },
          ],
        },
      ],
    },
  };
}

describe('Variant comparison report', () => {
  it('keeps declared estimates separate from measured candidates and kept results', () => {
    const report = createVariantComparisonReport(URI, SOURCE, buildEvidence());

    expect(report.build).toMatchObject({
      availability: 'available',
      status: 'completed',
      provenance: {
        projectId: 'project-a',
        unityVersion: '6000.0.31f1',
        buildTarget: 'StandaloneWindows64',
        collectedAt: 1_000_000,
      },
    });
    expect(report.comparisons).toHaveLength(2);
    const fragment = report.comparisons.find(({ context }) => (
      context.stage === 'fragment'
    ));
    expect(fragment).toMatchObject({
      context: {
        shaderName: 'Tests/Lit',
        passName: 'Forward',
        stage: 'fragment',
        buildTarget: 'StandaloneWindows64',
        graphicsApi: 'Direct3D11',
      },
      declared: {
        evidenceClass: 'declared',
        basis: 'static-upper-bound',
        availability: 'available',
        count: '12',
      },
      compileCandidates: {
        evidenceClass: 'compile-candidates',
        basis: 'unity-build',
        availability: 'available',
        count: '12',
      },
      kept: {
        evidenceClass: 'kept',
        basis: 'unity-build',
        availability: 'available',
        count: '2',
      },
    });
    expect(fragment?.keywordSets.map(({ identity, declaredToKeptGap }) => ({
      keywords: identity.keywords,
      gap: declaredToKeptGap,
    }))).toEqual([
      { keywords: ['QUALITY_LOW', 'QUALITY_HIGH', 'QUALITY_ULTRA'], gap: '3' },
      { keywords: ['NORMAL_MAP', 'DETAIL_MAP'], gap: '1' },
    ]);
    expect(report.largestDeclaredToKeptGaps[0]).toMatchObject({
      context: { stage: 'fragment' },
      keywordSet: {
        keywords: ['QUALITY_LOW', 'QUALITY_HIGH', 'QUALITY_ULTRA'],
      },
      gap: '3',
    });
  });

  it('reports unavailable build measurements without relabeling declared estimates', () => {
    const report = createVariantComparisonReport(URI, SOURCE, {
      availability: 'unavailable',
      reason: 'no-adapter',
    });

    expect(report.build).toEqual({
      availability: 'unavailable',
      reason: 'no-adapter',
    });
    expect(report.comparisons).toHaveLength(2);
    expect(report.comparisons.every((comparison) => (
      comparison.declared.evidenceClass === 'declared'
      && comparison.declared.availability === 'available'
      && comparison.compileCandidates.evidenceClass === 'compile-candidates'
      && comparison.compileCandidates.availability === 'unavailable'
      && comparison.compileCandidates.reason === 'no-adapter'
      && comparison.kept.evidenceClass === 'kept'
      && comparison.kept.availability === 'unavailable'
      && comparison.kept.reason === 'no-adapter'
    ))).toBe(true);
    expect(report.largestDeclaredToKeptGaps).toEqual([]);
  });

  it('retains partial compiler measurements when stripping fails', () => {
    const completed = buildEvidence();
    if (completed.availability !== 'available') throw new Error('expected fixture evidence');
    const failed: VariantBuildEvidenceResult = {
      availability: 'available',
      evidence: {
        ...completed.evidence,
        status: 'failed',
        failure: { phase: 'stripping', message: 'stripping callback failed' },
        contexts: completed.evidence.contexts.map((context) => ({
          ...context,
          kept: { availability: 'unavailable', reason: 'build-failed' },
          keywordSets: context.keywordSets.map((keywordSet) => ({
            ...keywordSet,
            kept: { availability: 'unavailable', reason: 'build-failed' },
          })),
        })),
      },
    };

    const report = createVariantComparisonReport(URI, SOURCE, failed);
    const fragment = report.comparisons.find(({ context }) => context.stage === 'fragment');

    expect(report.build).toMatchObject({
      availability: 'available',
      status: 'failed',
      failure: { phase: 'stripping' },
    });
    expect(fragment?.compileCandidates).toMatchObject({
      evidenceClass: 'compile-candidates',
      availability: 'available',
      count: '12',
    });
    expect(fragment?.kept).toEqual({
      evidenceClass: 'kept',
      basis: 'unity-build',
      availability: 'unavailable',
      reason: 'build-failed',
    });
    expect(report.largestDeclaredToKeptGaps).toEqual([]);
  });
});
