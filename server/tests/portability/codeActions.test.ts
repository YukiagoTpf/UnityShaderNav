import { describe, expect, it } from 'vitest';
import {
  createPortabilityReport,
  portabilityCodeActions,
  portabilityDiagnostics,
} from '../../src/portability';

const SOURCE = [
  'Shader "Portability/Unlit" {',
  '  SubShader {',
  '    Tags { "RenderType" = "Opaque" }',
  '    Pass {',
  '      CGPROGRAM',
  '      #pragma vertex vert',
  '      #pragma fragment frag',
  '      #include "UnityCG.cginc"',
  '      float4 vert(float3 p : POSITION) : SV_POSITION { return UnityObjectToClipPos(p); }',
  '      fixed4 frag() : SV_Target { return 1; }',
  '      ENDCG',
  '    }',
  '  }',
  '}',
].join('\n');

describe('portability Quick Fix boundary', () => {
  it('publishes Quick Fixes only for mechanically proven findings', () => {
    const uri = 'file:///project/Assets/Unlit.shader';
    const report = createPortabilityReport({
      uri,
      source: SOURCE,
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
    const diagnostics = portabilityDiagnostics(report);
    const mechanical = report.findings.filter((finding) => (
      finding.category === 'mechanical-change' && finding.safeFix
    ));

    expect(diagnostics).toHaveLength(mechanical.length);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === 4)).toBe(true);

    const actions = portabilityCodeActions(
      report,
      uri,
      9,
      { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } },
      { diagnostics },
    );
    expect(actions).toHaveLength(mechanical.length);
    expect(actions.every((action) => action.kind === 'quickfix')).toBe(true);
    expect(actions.every((action) => action.edit?.documentChanges?.every((change) => (
      'textDocument' in change && change.textDocument.version === 9
    )))).toBe(true);
    expect(actions.flatMap((action) => action.diagnostics ?? []).every((diagnostic) => (
      diagnostics.includes(diagnostic)
    ))).toBe(true);
  });
});
