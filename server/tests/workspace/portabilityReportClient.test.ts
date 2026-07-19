import { describe, expect, it } from 'vitest';
import type { PortabilityReport } from '@unity-shader-nav/shared';
import { formatPortabilityReportMarkdown } from '../../../client/src/portabilityReport';

describe('portability report Markdown', () => {
  it('shows version provenance, finding classes, and the equivalence boundary', () => {
    const report: PortabilityReport = {
      uri: 'file:///project/Assets/Unlit.shader',
      target: { kind: 'render-pipeline', pipeline: 'universal' },
      environment: {
        unityVersion: '2022.3.62f1',
        renderPipelinePackage: {
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        },
      },
      equivalence: 'not-claimed',
      compilerVerification: { status: 'required' },
      findings: [
        {
          id: 'mechanical',
          category: 'mechanical-change',
          area: 'include',
          title: 'Use Core.hlsl',
          explanation: 'Exact include replacement.',
          safeFix: { title: 'Use Core.hlsl', edits: [] },
        },
        {
          id: 'human',
          category: 'human-rewrite',
          area: 'feature',
          title: 'Rewrite lighting',
          explanation: 'Pipeline lighting semantics differ.',
        },
        {
          id: 'unsupported',
          category: 'unsupported-semantic',
          area: 'feature',
          title: 'Surface Shader unsupported',
          explanation: 'URP has no Surface Shader code generation.',
        },
        {
          id: 'verify',
          category: 'verification-requirement',
          area: 'compiler',
          title: 'Compile in Unity',
          explanation: 'Run an Adapter profile.',
        },
      ],
    };

    const markdown = formatPortabilityReportMarkdown(report);

    expect(markdown).toContain('Unity 2022.3.62f1');
    expect(markdown).toContain('com.unity.render-pipelines.universal 14.0.11');
    expect(markdown).toContain('## Mechanical changes');
    expect(markdown).toContain('## Human semantic work');
    expect(markdown).toContain('## Unsupported targets or semantics');
    expect(markdown).toContain('## Compiler verification');
    expect(markdown).toContain('does not claim rendered equivalence');
    expect(markdown).toContain('Quick Fix available');
  });
});
