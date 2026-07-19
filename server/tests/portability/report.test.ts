import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Range } from '@unity-shader-nav/shared';
import { createPortabilityReport } from '../../src/portability';
import versionPairs from './fixtures/version-pairs.json';

const URI = 'file:///project/Assets/UnlitColor.shader';

const BIRP_UNLIT = [
  'Shader "Portability/UnlitColor"',
  '{',
  '    SubShader',
  '    {',
  '        Tags { "RenderType" = "Opaque" }',
  '        Pass',
  '        {',
  '            CGPROGRAM',
  '            #pragma vertex vert',
  '            #pragma fragment frag',
  '            #include "UnityCG.cginc"',
  '',
  '            struct Attributes { float3 positionOS : POSITION; };',
  '            struct Varyings { float4 positionCS : SV_POSITION; };',
  '',
  '            Varyings vert(Attributes input)',
  '            {',
  '                Varyings output;',
  '                output.positionCS = UnityObjectToClipPos(input.positionOS);',
  '                return output;',
  '            }',
  '',
  '            fixed4 frag() : SV_Target { return fixed4(1, 0, 0, 1); }',
  '            ENDCG',
  '        }',
  '    }',
  '}',
].join('\n');

const URP_UNLIT = BIRP_UNLIT
  .replace('Tags { "RenderType" = "Opaque" }', 'Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }')
  .replace('CGPROGRAM', 'HLSLPROGRAM')
  .replace('ENDCG', 'ENDHLSL')
  .replace('"UnityCG.cginc"', '"Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"')
  .replace('UnityObjectToClipPos', 'TransformObjectToHClip')
  .replaceAll('fixed4', 'half4');

function sourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function offsetAt(source: string, position: Range['start']): number {
  const lines = source.split('\n');
  return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0)
    + position.character;
}

function applyEdits(
  source: string,
  edits: readonly { readonly range: Range; readonly newText: string }[],
): string {
  return [...edits]
    .map((edit) => ({
      ...edit,
      start: offsetAt(source, edit.range.start),
      end: offsetAt(source, edit.range.end),
    }))
    .sort((left, right) => right.start - left.start)
    .reduce((result, edit) => (
      result.slice(0, edit.start) + edit.newText + result.slice(edit.end)
    ), source);
}

describe('custom Shader portability report', () => {
  it('offers only mechanical edits for a narrow BiRP-to-URP unlit migration', () => {
    const report = createPortabilityReport({
      uri: URI,
      source: BIRP_UNLIT,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });

    expect(report.environment).toEqual(expect.objectContaining({
      unityVersion: '2022.3.62f1',
      renderPipelinePackage: expect.objectContaining({ version: '14.0.11' }),
    }));
    expect(report.equivalence).toBe('not-claimed');
    expect(report.findings.some((finding) => (
      finding.category === 'verification-requirement'
    ))).toBe(true);

    const safeFixes = report.findings.flatMap((finding) => (
      finding.safeFix ? [finding.safeFix] : []
    ));
    expect(safeFixes.length).toBeGreaterThan(0);
    expect(report.findings.filter((finding) => finding.safeFix).every((finding) => (
      finding.category === 'mechanical-change'
    ))).toBe(true);
    expect(applyEdits(BIRP_UNLIT, safeFixes.flatMap((fix) => fix.edits))).toBe(URP_UNLIT);
  });

  it('inserts a missing RenderPipeline tag at SubShader scope', () => {
    const source = BIRP_UNLIT.replace(
      '        Tags { "RenderType" = "Opaque" }\n',
      '',
    );
    const expected = URP_UNLIT.replace(
      '        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }',
      '        Tags { "RenderPipeline" = "UniversalPipeline" }',
    );
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });
    const safeFixes = report.findings.flatMap((finding) => (
      finding.safeFix ? [finding.safeFix] : []
    ));

    expect(applyEdits(source, safeFixes.flatMap((fix) => fix.edits))).toBe(expected);
  });

  it('never edits fixed-like text in ShaderLab strings', () => {
    const source = BIRP_UNLIT.replace(
      'Shader "Portability/UnlitColor"',
      'Shader "Portability/fixed4-UnlitColor"',
    );
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });
    const migrated = applyEdits(source, report.findings.flatMap((finding) => (
      finding.safeFix?.edits ?? []
    )));

    expect(migrated).toContain('Shader "Portability/fixed4-UnlitColor"');
  });

  it('never edits transform or precision names inside program strings', () => {
    const source = BIRP_UNLIT.replace(
      '            #pragma fragment frag',
      [
        '            #pragma fragment frag',
        '            #pragma message "fixed4 UnityObjectToClipPos"',
      ].join('\n'),
    );
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });
    const migrated = applyEdits(source, report.findings.flatMap((finding) => (
      finding.safeFix?.edits ?? []
    )));

    expect(migrated).toContain('#pragma message "fixed4 UnityObjectToClipPos"');
  });

  it('never treats pragma arguments as transform calls or precision types', () => {
    const source = BIRP_UNLIT.replace(
      '            #pragma fragment frag',
      [
        '            #pragma fragment frag',
        '            #pragma custom UnityObjectToClipPos fixed4',
      ].join('\n'),
    );
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });
    const migrated = applyEdits(source, report.findings.flatMap((finding) => (
      finding.safeFix?.edits ?? []
    )));

    expect(migrated).toContain('#pragma custom UnityObjectToClipPos fixed4');
  });

  it('does not rewrite a locally declared transform symbol as the URP helper', () => {
    const source = BIRP_UNLIT.replace(
      '            Varyings vert(Attributes input)',
      [
        '            float4 UnityObjectToClipPos(float3 positionOS)',
        '            {',
        '                return float4(positionOS, 1);',
        '            }',
        '',
        '            Varyings vert(Attributes input)',
      ].join('\n'),
    );
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });
    const migrated = applyEdits(source, report.findings.flatMap((finding) => (
      finding.safeFix?.edits ?? []
    )));

    expect(migrated).toContain('float4 UnityObjectToClipPos(float3 positionOS)');
    expect(migrated).toContain('UnityObjectToClipPos(input.positionOS)');
    expect(report.findings).toContainEqual(expect.objectContaining({
      id: 'urp-shadowed-transform-helper',
      category: 'human-rewrite',
    }));
  });

  it('targets real program markers when comments repeat their names', () => {
    const source = BIRP_UNLIT
      .replace('            CGPROGRAM', '            /* CGPROGRAM */ CGPROGRAM')
      .replace('            ENDCG', '            /* ENDCG */ ENDCG');
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });
    const migrated = applyEdits(source, report.findings.flatMap((finding) => (
      finding.safeFix?.edits ?? []
    )));

    expect(migrated).toContain('/* CGPROGRAM */ HLSLPROGRAM');
    expect(migrated).toContain('/* ENDCG */ ENDHLSL');
  });

  it('adds a valid RenderPipeline tag when existing Tags have no inner whitespace', () => {
    const source = BIRP_UNLIT.replace(
      'Tags { "RenderType" = "Opaque" }',
      'Tags {"RenderType"="Opaque"}',
    );
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });
    const migrated = applyEdits(source, report.findings.flatMap((finding) => (
      finding.safeFix?.edits ?? []
    )));

    expect(migrated).toContain(
      'Tags {"RenderType"="Opaque" "RenderPipeline" = "UniversalPipeline" }',
    );
  });

  it('gives repeated include fixes distinct diagnostic identities', () => {
    const source = BIRP_UNLIT.replace(
      '            #include "UnityCG.cginc"',
      [
        '            #include "UnityCG.cginc"',
        '            #include "UnityCG.cginc"',
      ].join('\n'),
    );
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });
    const includeFindings = report.findings.filter((finding) => (
      finding.area === 'include' && finding.safeFix
    ));

    expect(includeFindings).toHaveLength(2);
    expect(new Set(includeFindings.map((finding) => finding.id)).size).toBe(2);
  });

  it('never offers equivalence fixes for Surface, lighting, or multi-Pass semantics', () => {
    const source = [
      'Shader "Portability/Complex" {',
      '  SubShader {',
      '    Pass {',
      '      CGPROGRAM',
      '      #pragma surface surf Standard',
      '      #include "Lighting.cginc"',
      '      half4 LightingLegacy() { return 1; }',
      '      ENDCG',
      '    }',
      '    Pass {',
      '      CGPROGRAM',
      '      #pragma vertex vert',
      '      #pragma fragment frag',
      '      ENDCG',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'unsupported-semantic',
        area: 'feature',
        title: expect.stringContaining('Surface'),
      }),
      expect.objectContaining({
        category: 'human-rewrite',
        area: 'feature',
        title: expect.stringContaining('lighting'),
      }),
      expect.objectContaining({
        category: 'human-rewrite',
        area: 'pass-tag',
        title: expect.stringContaining('multi-Pass'),
      }),
    ]));
    expect(report.findings).toContainEqual(expect.objectContaining({
      id: 'urp-shape-verification',
      category: 'verification-requirement',
    }));
    expect(report.findings.some((finding) => (
      finding.id === 'urp-version-unverified'
    ))).toBe(false);
    expect(report.findings.every((finding) => finding.safeFix === undefined)).toBe(true);
  });

  it('classifies Built-In LightMode ownership as human Pass work', () => {
    const source = BIRP_UNLIT.replace(
      '        {\n            CGPROGRAM',
      [
        '        {',
        '            Tags { "LightMode" = "ForwardBase" }',
        '            CGPROGRAM',
      ].join('\n'),
    );
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      id: 'urp-light-mode-rewrite',
      category: 'human-rewrite',
      area: 'pass-tag',
    }));
    expect(report.findings.every((finding) => finding.safeFix === undefined)).toBe(true);
  });

  it('withholds every safe fix for a single-Pass Surface Shader', () => {
    const source = [
      'Shader "Portability/Surface" {',
      '  SubShader {',
      '    Tags { "RenderType" = "Opaque" }',
      '    Pass {',
      '      CGPROGRAM',
      '      #pragma surface surf Standard',
      '      #include "UnityCG.cginc"',
      '      void surf() {}',
      '      ENDCG',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      id: 'urp-surface-shader-unsupported',
      category: 'unsupported-semantic',
    }));
    expect(report.findings.some((finding) => (
      finding.id === 'urp-version-unverified'
    ))).toBe(false);
    expect(report.findings.every((finding) => finding.safeFix === undefined)).toBe(true);
  });

  it('withholds fixes when the current project has no official URP Package evidence', () => {
    const report = createPortabilityReport({
      uri: URI,
      source: BIRP_UNLIT,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [],
      },
    });

    expect(report.environment.renderPipelinePackage).toBeUndefined();
    expect(report.findings).toContainEqual(expect.objectContaining({
      category: 'unsupported-semantic',
      title: expect.stringContaining('URP target is unavailable'),
    }));
    expect(report.findings.every((finding) => finding.safeFix === undefined)).toBe(true);
  });

  it('gates mechanical rules by documented Unity and URP Package version pairs', () => {
    for (const fixture of versionPairs) {
      const report = createPortabilityReport({
        uri: URI,
        source: BIRP_UNLIT,
        target: { kind: 'render-pipeline', pipeline: 'universal' },
        environment: {
          unityVersion: fixture.unityVersion,
          renderPipelinePackages: [{
            name: 'com.unity.render-pipelines.universal',
            version: fixture.urpVersion,
            source: 'registry',
            official: true,
          }],
        },
      });
      const hasSafeFix = report.findings.some((finding) => finding.safeFix);

      expect(
        hasSafeFix,
        `${fixture.unityVersion} / URP ${fixture.urpVersion}`,
      ).toBe(fixture.mechanicalRules);
    }
  });

  it('classifies missing UnityPerMaterial work without inventing a cbuffer edit', () => {
    const source = BIRP_UNLIT
      .replace('    SubShader', [
        '    Properties {',
        '        _Tint ("Tint", Color) = (1, 1, 1, 1)',
        '    }',
        '    SubShader',
      ].join('\n'))
      .replace('            struct Attributes', [
        '            fixed4 _Tint;',
        '            struct Attributes',
      ].join('\n'));
    const report = createPortabilityReport({
      uri: URI,
      source,
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [{
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        }],
      },
    });

    const cbuffer = report.findings.find((finding) => finding.area === 'cbuffer');
    expect(cbuffer).toEqual(expect.objectContaining({
      category: 'human-rewrite',
      title: expect.stringContaining('UnityPerMaterial'),
    }));
    expect(cbuffer?.safeFix).toBeUndefined();
  });

  it('records an exact graphics-profile compiler pass without claiming equivalence', () => {
    const profile = {
      name: 'Windows Vulkan',
      platform: 'StandaloneWindows64',
      graphicsApi: 'Vulkan',
      capability: 'shader-messages',
    } as const;
    const report = createPortabilityReport({
      uri: URI,
      source: BIRP_UNLIT,
      target: { kind: 'graphics-profile', profile },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [],
      },
      compilerResult: {
        status: 'completed',
        profile,
        durationMs: 18,
        success: true,
        warningCount: 1,
        errorCount: 0,
        diagnostics: [{
          shaderMessage: { message: 'verified fixture', severity: 'warning' },
          profile,
          provenance: {
            capability: 'shader-messages',
            adapterVersion: '1.0.0',
            unityVersion: '2022.3.62f1',
            projectId: 'project',
            instanceId: 'instance',
            collectedAt: 1,
            sourceRevision: {
              uri: URI,
              assetGuid: 'guid',
              contentHash: sourceHash(BIRP_UNLIT),
            },
          },
        }],
      },
    });

    expect(report.compilerVerification).toEqual({
      status: 'passed',
      profile,
      unityVersion: '2022.3.62f1',
      durationMs: 18,
      warningCount: 1,
      errorCount: 0,
    });
    expect(report.equivalence).toBe('not-claimed');
    expect(report.findings.some((finding) => finding.safeFix)).toBe(false);
  });

  it('rejects an empty completed result that carries no exact-source evidence', () => {
    const profile = {
      name: 'Windows Vulkan',
      platform: 'StandaloneWindows64',
      graphicsApi: 'Vulkan',
      capability: 'shader-messages',
    } as const;
    const report = createPortabilityReport({
      uri: URI,
      source: BIRP_UNLIT,
      target: { kind: 'graphics-profile', profile },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [],
      },
      compilerResult: {
        status: 'completed',
        profile,
        durationMs: 18,
        success: true,
        warningCount: 0,
        errorCount: 0,
        diagnostics: [],
      },
    });

    expect(report.compilerVerification).toEqual({
      status: 'unavailable',
      profile,
      reason: 'invalid-evidence',
    });
  });

  it('rejects compiler evidence from a different Unity version', () => {
    const profile = {
      name: 'Windows Vulkan',
      platform: 'StandaloneWindows64',
      graphicsApi: 'Vulkan',
      capability: 'shader-messages',
    } as const;
    const report = createPortabilityReport({
      uri: URI,
      source: BIRP_UNLIT,
      target: { kind: 'graphics-profile', profile },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackages: [],
      },
      compilerResult: {
        status: 'completed',
        profile,
        durationMs: 18,
        success: true,
        warningCount: 1,
        errorCount: 0,
        diagnostics: [{
          shaderMessage: { message: 'warning', severity: 'warning' },
          profile,
          provenance: {
            capability: 'shader-messages',
            adapterVersion: '1.0.0',
            unityVersion: '6000.0.42f1',
            projectId: 'project',
            instanceId: 'instance',
            collectedAt: 1,
            sourceRevision: {
              uri: URI,
              assetGuid: 'guid',
              contentHash: sourceHash(BIRP_UNLIT),
            },
          },
        }],
      },
    });

    expect(report.compilerVerification).toEqual({
      status: 'unavailable',
      profile,
      reason: 'invalid-evidence',
    });
  });
});
