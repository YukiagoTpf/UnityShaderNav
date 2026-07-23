import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CompileProfile, ShaderMessage } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import {
  type CapturedCompileEvidence,
  type ShaderCompileContract,
  contractWithCurrentWarningBaselines,
  evaluateShaderCompileContract,
  formatShaderCompileReport,
  parseShaderCompileContract,
  shaderCompileExitCode,
} from '../../src/contracts/shaderCompileContract';

const ROOT = resolve('/repo');
const PROFILE: CompileProfile = {
  name: 'Windows D3D11',
  platform: 'StandaloneWindows64',
  graphicsApi: 'Direct3D11',
  capability: 'compile-profile/windows-d3d11',
};

function shader(options: { missingField?: boolean } = {}): string {
  return [
    'Shader "Tests/Contract" {',
    '  Properties {',
    '    _Tint ("Tint", Color) = (1, 1, 1, 1)',
    '  }',
    '  SubShader {',
    '    Tags { "RenderPipeline" = "UniversalPipeline" }',
    '    Pass {',
    '      Name "Forward"',
    '      HLSLPROGRAM',
    '      #pragma vertex vert',
    '      #pragma fragment frag',
    '      #pragma multi_compile _ CONTRACT_FEATURE',
    '      CBUFFER_START(UnityPerMaterial)',
    ...(options.missingField ? [] : ['        float4 _Tint;']),
    '      CBUFFER_END',
    '      float4 vert() : SV_POSITION { return 0; }',
    '      float4 frag() : SV_Target { return _Tint; }',
    '      ENDHLSL',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function contentHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function evidence(
  source: string,
  diagnostics: readonly ShaderMessage[] = [],
  supportedFeatures: readonly string[] = [
    'shader-messages',
    'variant-build-evidence',
    PROFILE.capability,
  ],
): CapturedCompileEvidence {
  return {
    schemaVersion: 1,
    status: 'completed',
    supportedFeatures,
    profile: PROFILE,
    durationMs: 23,
    provenance: {
      capability: 'shader-messages',
      adapterVersion: 'fixture-adapter',
      unityVersion: '2022.3.62f1',
      projectId: 'fixture-project',
      instanceId: 'fixture-instance',
      collectedAt: 1_000,
      sourceRevision: {
        uri: 'file:///repo/Assets/Test.shader',
        assetGuid: 'fixture-guid',
        contentHash: contentHash(source),
      },
    },
    diagnostics,
  };
}

function budgetContract(declaredMax = '100') {
  return {
    schemaVersion: 1,
    budgets: [{
      id: 'contract-budget',
      source: 'Assets/Test.shader',
      selector: { shaderName: 'Tests/Contract' },
      limits: { declaredMax },
      policy: { contextChanges: 'allow', keywordSetChanges: 'allow' },
    }],
  };
}

function contract(
  overrides: Partial<ShaderCompileContract> = {},
): ShaderCompileContract {
  return {
    schemaVersion: 1,
    policy: { unverified: 'fail' },
    requiredCapabilities: ['shader-messages', 'variant-build-evidence'],
    scopes: [{
      id: 'contract-shader',
      source: 'Assets/Test.shader',
      srpBatcher: 'required',
      profiles: [{
        profile: PROFILE,
        evidence: 'Evidence/Test.json',
        warnings: {
          forbiddenMessageSubstrings: ['forbidden'],
          baseline: [],
        },
      }],
    }],
    variantBudgets: 'budgets.json',
    ...overrides,
  };
}

function ioFor(input: {
  source?: string;
  compileEvidence?: unknown;
  budgets?: unknown;
}) {
  const source = input.source ?? shader();
  const values = new Map<string, string>([
    [resolve(ROOT, 'Assets/Test.shader'), source],
    [resolve(ROOT, 'Evidence/Test.json'), JSON.stringify(
      input.compileEvidence ?? evidence(source),
    )],
    [resolve(ROOT, 'budgets.json'), JSON.stringify(
      input.budgets ?? budgetContract(),
    )],
  ]);
  return {
    readText: async (path: string) => {
      const value = values.get(path);
      if (value === undefined) throw new Error('fixture is missing');
      return value;
    },
  };
}

describe('repository Shader compile contract', () => {
  it('passes exact SRP, profile, capability, warning, and Variant budget evidence', async () => {
    const first = await evaluateShaderCompileContract(contract(), ROOT, ioFor({}));
    const second = await evaluateShaderCompileContract(contract(), ROOT, ioFor({}));

    expect(first).toMatchObject({
      status: 'pass',
      summary: { passed: 3, failed: 0, unverified: 0 },
      scopes: [{
        status: 'pass',
        srpBatcher: { status: 'pass' },
        profiles: [{
          status: 'pass',
          durationMs: 23,
          warnings: [],
          errors: [],
        }],
      }],
      variantBudgets: {
        report: { status: 'pass' },
      },
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(formatShaderCompileReport(first)).toBe(formatShaderCompileReport(second));
    expect(JSON.stringify(first)).not.toContain(ROOT);
    expect(JSON.stringify(first)).not.toContain('generatedAt');
    expect(shaderCompileExitCode(first)).toBe(0);
  });

  it('fails new warnings, compiler errors, and explicitly forbidden warning text', async () => {
    const source = shader();
    const diagnostics: ShaderMessage[] = [
      {
        message: 'new warning',
        severity: 'warning',
        file: '/private/build/Test.shader',
        line: 7,
      },
      {
        message: 'forbidden legacy path',
        severity: 'warning',
        file: 'C:\\agent\\work\\Test.shader',
        line: 8,
      },
      { message: 'compile error', severity: 'error', line: 9 },
    ];
    const first = await evaluateShaderCompileContract(
      contract(),
      ROOT,
      ioFor({ source, compileEvidence: evidence(source, diagnostics) }),
    );
    expect(first).toMatchObject({
      status: 'failed',
      scopes: [{
        profiles: [{
          status: 'failed',
          newWarnings: expect.arrayContaining([expect.any(String)]),
          violations: expect.arrayContaining([
            '1 compiler error(s)',
            '2 new compiler warning(s)',
            "forbidden compiler warning contains 'forbidden': forbidden legacy path",
          ]),
        }],
      }],
    });
    expect(shaderCompileExitCode(first)).toBe(1);
    expect(JSON.stringify(first)).not.toContain('/private/build');
    expect(JSON.stringify(first)).not.toContain('C:\\\\agent');

    const updated = contractWithCurrentWarningBaselines(contract(), first);
    expect(updated.scopes[0].profiles[0].warnings.baseline).toHaveLength(2);
    const afterBaseline = await evaluateShaderCompileContract(
      updated,
      ROOT,
      ioFor({ source, compileEvidence: evidence(source, diagnostics) }),
    );
    expect(afterBaseline.scopes[0].profiles[0]).toMatchObject({
      status: 'failed',
      newWarnings: [],
      violations: expect.arrayContaining([
        '1 compiler error(s)',
        "forbidden compiler warning contains 'forbidden': forbidden legacy path",
      ]),
    });
  });

  it('fails a deterministic SRP Batcher Property contract violation', async () => {
    const source = shader({ missingField: true });
    const report = await evaluateShaderCompileContract(
      contract(),
      ROOT,
      ioFor({ source, compileEvidence: evidence(source) }),
    );

    expect(report).toMatchObject({
      status: 'failed',
      scopes: [{
        srpBatcher: {
          status: 'failed',
          diagnostics: [{
            code: 'srp-batcher-property',
            message: expect.stringContaining('_Tint'),
          }],
        },
        profiles: [{ status: 'pass' }],
      }],
    });
  });

  it('keeps a partial capability result unverified while other checks survive', async () => {
    const source = shader();
    const report = await evaluateShaderCompileContract(
      contract(),
      ROOT,
      ioFor({
        source,
        compileEvidence: evidence(source, [], [
          'shader-messages',
          PROFILE.capability,
        ]),
      }),
    );

    expect(report).toMatchObject({
      status: 'unverified',
      summary: { passed: 2, failed: 0, unverified: 1 },
      scopes: [{
        srpBatcher: { status: 'pass' },
        profiles: [{
          status: 'unverified',
          reason: 'compile evidence is missing capabilities: variant-build-evidence',
        }],
      }],
      variantBudgets: { report: { status: 'pass' } },
    });
    expect(shaderCompileExitCode(report)).toBe(2);
    expect(shaderCompileExitCode({
      ...report,
      policy: { unverified: 'allow' },
    })).toBe(0);
    expect(() => contractWithCurrentWarningBaselines(contract(), report))
      .toThrow('compile evidence is unverified');
  });

  it('reports missing Adapter or license evidence as unverified, never passing', async () => {
    const report = await evaluateShaderCompileContract(
      contract(),
      ROOT,
      ioFor({
        compileEvidence: {
          schemaVersion: 1,
          status: 'unavailable',
          reason: 'unity-license-unavailable',
        },
      }),
    );

    expect(report.scopes[0].profiles[0]).toMatchObject({
      status: 'unverified',
      reason: 'unity-license-unavailable',
    });
    expect(report.status).toBe('unverified');
  });

  it('propagates Variant budget regressions through the single contract result', async () => {
    const report = await evaluateShaderCompileContract(
      contract(),
      ROOT,
      ioFor({ budgets: budgetContract('0') }),
    );

    expect(report).toMatchObject({
      status: 'failed',
      variantBudgets: {
        report: {
          status: 'failed',
          budgets: [{
            status: 'failed',
            declared: {
              violations: [expect.stringContaining('exceeds max 0')],
            },
          }],
        },
      },
    });
  });

  it('rejects ambiguous contracts instead of silently weakening CI coverage', () => {
    expect(() => parseShaderCompileContract({
      ...contract(),
      requiredCapabilities: [],
    })).toThrow('must not be empty');
    expect(() => parseShaderCompileContract({
      ...contract(),
      scopes: [contract().scopes[0], contract().scopes[0]],
    })).toThrow("Duplicate scope id 'contract-shader'");
    expect(() => parseShaderCompileContract({
      ...contract(),
      policy: { unverified: 'maybe' },
    })).toThrow("policy.unverified must be 'fail' or 'allow'");
  });
});
