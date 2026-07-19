import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AdapterCompilerEvidence,
  CompilerDocumentKind,
} from '@unity-shader-nav/shared';
import {
  buildCompilerDocumentMap,
  mapFromCompilerDocument,
  mapToCompilerDocument,
} from '../../src/adapter/compilerSourceMap';

const SHADER_URI = 'file:///project/Assets/Context.shader';
const INCLUDE_URI = 'file:///project/Assets/Common.hlsl';
const PROFILE = {
  name: 'd3d11',
  platform: 'StandaloneWindows64',
  graphicsApi: 'Direct3D11',
  capability: 'compile-profile/d3d11',
} as const;

const SHADER_SOURCE = [
  'Shader "Context" {',
  'HLSLPROGRAM',
  'float4 vert() { return 1; }',
  'EXPAND_COLOR()',
  'ENDHLSL',
  '}',
].join('\n');
const INCLUDE_SOURCE = [
  '// common',
  'float4 Common() { return 0; }',
].join('\n');

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function evidence(
  kind: CompilerDocumentKind,
  text: string,
): AdapterCompilerEvidence {
  const otherKind = kind === 'generated' ? 'preprocessed' : 'generated';
  return {
    sources: [
      {
        identity: {
          uri: SHADER_URI,
          sourceId: 'shader-guid',
          contentHash: hash(SHADER_SOURCE),
        },
        text: SHADER_SOURCE,
        lineDirectiveNames: ['Assets/Context.shader'],
      },
      {
        identity: {
          uri: INCLUDE_URI,
          sourceId: 'include-guid',
          contentHash: hash(INCLUDE_SOURCE),
        },
        text: INCLUDE_SOURCE,
        lineDirectiveNames: ['Assets/Common.hlsl'],
      },
    ],
    documents: [
      { kind, text },
      { kind: otherKind, text: '' },
    ],
    provenance: {
      capability: 'compiler-evidence',
      adapterVersion: '0.1.0',
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      instanceId: 'instance-a',
      collectedAt: 100,
      contextId: 'context-a',
      profile: PROFILE,
      sourceRevision: {
        uri: SHADER_URI,
        assetGuid: 'shader-guid',
        contentHash: hash(SHADER_SOURCE),
      },
    },
  };
}

describe('compiler #line source maps', () => {
  it('maps exact ShaderLab-embedded and include lines in both directions', () => {
    const text = [
      '#line 3 "Assets/Context.shader"',
      'float4 vert() { return 1; }',
      '#line 2 "Assets/Common.hlsl"',
      'float4 Common() { return 0; }',
    ].join('\n');
    const snapshot = evidence('preprocessed', text);
    const map = buildCompilerDocumentMap(
      snapshot,
      snapshot.documents[0]!,
      'unity-shader-nav-compiler://evidence/id/preprocessed.hlsl',
    );

    expect(mapFromCompilerDocument(map, { line: 3, character: 7 })).toEqual({
      locations: [{
        uri: SHADER_URI,
        range: {
          start: { line: 2, character: 7 },
          end: { line: 2, character: 7 },
        },
        sourceIdentity: {
          uri: SHADER_URI,
          sourceId: 'shader-guid',
          contentHash: hash(SHADER_SOURCE),
        },
        provenance: expect.objectContaining({
          method: 'line-directive',
          granularity: 'line',
          evidence: snapshot.provenance,
          directive: {
            documentLine: 2,
            sourceLine: 2,
            sourceName: 'Assets/Context.shader',
          },
        }),
      }],
    });
    expect(mapFromCompilerDocument(map, { line: 5, character: 4 })).toMatchObject({
      locations: [{
        uri: INCLUDE_URI,
        range: {
          start: { line: 1, character: 4 },
          end: { line: 1, character: 4 },
        },
        sourceIdentity: { sourceId: 'include-guid' },
      }],
    });
    expect(mapToCompilerDocument(map, INCLUDE_URI, {
      line: 1,
      character: 9,
    })).toMatchObject([{
      uri: 'unity-shader-nav-compiler://evidence/id/preprocessed.hlsl',
      range: {
        start: { line: 5, character: 9 },
        end: { line: 5, character: 9 },
      },
      sourceIdentity: { uri: INCLUDE_URI, sourceId: 'include-guid' },
    }]);
  });

  it('keeps macro-expanded lines as visible gaps instead of projecting columns', () => {
    const text = [
      '#line 4 "Assets/Context.shader"',
      'float4 expanded = float4(1, 0, 0, 1);',
    ].join('\n');
    const snapshot = evidence('preprocessed', text);
    const map = buildCompilerDocumentMap(
      snapshot,
      snapshot.documents[0]!,
      'unity-shader-nav-compiler://evidence/id/preprocessed.hlsl',
    );

    expect(mapFromCompilerDocument(map, { line: 3, character: 8 })).toEqual({
      locations: [],
      unmappedReason: 'macro-expansion',
    });
    expect(mapToCompilerDocument(map, SHADER_URI, {
      line: 3,
      character: 0,
    })).toEqual([]);
  });

  it('marks compiler-only code before or after source directives as generated-only', () => {
    const text = [
      'struct UnityGeneratedInput { float4 value; };',
      '#line 3 "Assets/Context.shader"',
      'float4 vert() { return 1; }',
      '#line default',
      'float4 UnityGeneratedWrapper() { return vert(); }',
    ].join('\n');
    const snapshot = evidence('generated', text);
    const map = buildCompilerDocumentMap(
      snapshot,
      snapshot.documents[0]!,
      'unity-shader-nav-compiler://evidence/id/generated.hlsl',
    );

    expect(mapFromCompilerDocument(map, { line: 2, character: 2 })).toEqual({
      locations: [],
      unmappedReason: 'generated-only',
    });
    expect(mapFromCompilerDocument(map, { line: 6, character: 2 })).toEqual({
      locations: [],
      unmappedReason: 'generated-only',
    });
  });

  it('does not guess unknown or ambiguous #line source names', () => {
    const unknownText = [
      '#line 1 "Library/Generated/Unknown.hlsl"',
      'float4 Unknown;',
    ].join('\n');
    const unknown = evidence('preprocessed', unknownText);
    const unknownMap = buildCompilerDocumentMap(
      unknown,
      unknown.documents[0]!,
      'unity-shader-nav-compiler://evidence/id/preprocessed.hlsl',
    );
    expect(mapFromCompilerDocument(unknownMap, { line: 3, character: 0 })).toEqual({
      locations: [],
      unmappedReason: 'unknown-source',
    });

    const ambiguous = {
      ...unknown,
      sources: unknown.sources.map((source) => ({
        ...source,
        lineDirectiveNames: ['same.hlsl'],
      })),
      documents: [
        { kind: 'preprocessed' as const, text: '#line 1 "same.hlsl"\nanything' },
        { kind: 'generated' as const, text: '' },
      ],
    };
    const ambiguousMap = buildCompilerDocumentMap(
      ambiguous,
      ambiguous.documents[0],
      'unity-shader-nav-compiler://evidence/id/preprocessed.hlsl',
    );
    expect(mapFromCompilerDocument(ambiguousMap, { line: 3, character: 0 })).toEqual({
      locations: [],
      unmappedReason: 'ambiguous-source',
    });
  });
});
