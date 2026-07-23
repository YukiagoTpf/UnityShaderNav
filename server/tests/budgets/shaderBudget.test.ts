import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VariantBuildEvidence } from '@unity-shader-nav/shared';
import {
  contractWithCurrentBaselines,
  evaluateShaderBudgets,
  formatShaderBudgetReport,
  parseShaderBudgetContract,
  type ShaderBudgetContract,
} from '../../src/budgets/shaderBudget';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function shaderSource(
  passes: readonly {
    readonly name: string;
    readonly pragmas?: readonly string[];
  }[] = [{
    name: 'Forward',
    pragmas: [
      '#pragma multi_compile_fragment _ QUALITY_LOW QUALITY_HIGH',
      '#pragma shader_feature_local_fragment _NORMALMAP',
    ],
  }],
): string {
  return [
    'Shader "Tests/Budget" {',
    '  SubShader {',
    ...passes.flatMap((pass) => [
      '    Pass {',
      `      Name "${pass.name}"`,
      '      HLSLPROGRAM',
      '#pragma vertex vert',
      '#pragma fragment frag',
      ...(pass.pragmas ?? [
        '#pragma multi_compile_fragment _ QUALITY_LOW QUALITY_HIGH',
      ]),
      'float4 vert() : SV_Position { return 0; }',
      'float4 frag() : SV_Target { return 0; }',
      '      ENDHLSL',
      '    }',
    ]),
    '  }',
    '}',
  ].join('\n');
}

function completedEvidence(source: string): VariantBuildEvidence {
  return {
    status: 'completed',
    provenance: {
      capability: 'variant-build-evidence',
      projectId: 'project-a',
      instanceId: 'editor-1',
      adapterVersion: '0.3.0',
      unityVersion: '6000.0.31f1',
      buildTarget: 'StandaloneWindows64',
      collectedAt: 1_000_000,
      sourceRevision: {
        uri: 'file:///project/Assets/Shaders/Budget.shader',
        assetGuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contentHash: sha256(source),
      },
    },
    contexts: [{
      shaderName: 'Tests/Budget',
      subShaderIndex: 0,
      passIndex: 0,
      passName: 'Forward',
      stage: 'fragment',
      graphicsApi: 'Direct3D11',
      compileCandidates: { availability: 'available', count: '6' },
      kept: { availability: 'available', count: '2' },
      keywordSets: [{
        keywords: ['QUALITY_LOW', 'QUALITY_HIGH'],
        scope: 'global',
        stage: 'fragment',
        hasBlankOption: true,
        compileCandidates: { availability: 'available', count: '3' },
        kept: { availability: 'available', count: '2' },
      }, {
        keywords: ['_NORMALMAP'],
        scope: 'local',
        stage: 'fragment',
        hasBlankOption: true,
        compileCandidates: { availability: 'available', count: '2' },
        kept: { availability: 'available', count: '1' },
      }],
    }],
  };
}

async function fixture(source = shaderSource()): Promise<{
  readonly root: string;
  readonly sourcePath: string;
  readonly evidencePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'usn-shader-budget-'));
  roots.push(root);
  const sourcePath = join(root, 'Assets', 'Shaders', 'Budget.shader');
  const evidencePath = join(root, 'evidence', 'Budget.json');
  await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
  await mkdir(join(root, 'evidence'), { recursive: true });
  await writeFile(sourcePath, source);
  await writeFile(
    evidencePath,
    `${JSON.stringify(completedEvidence(source), null, 2)}\n`,
  );
  return { root, sourcePath, evidencePath };
}

function contractValue(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    budgets: [{
      id: 'windows-forward',
      source: 'Assets/Shaders/Budget.shader',
      evidence: 'evidence/Budget.json',
      selector: {
        shaderName: 'Tests/Budget',
        subShaderIndex: 0,
        passIndex: 0,
        passName: 'Forward',
        stage: 'fragment',
        buildTarget: 'StandaloneWindows64',
        graphicsApi: 'Direct3D11',
      },
      limits: {
        declaredMax: '6',
        keptMax: '2',
      },
      ...overrides,
    }],
  };
}

describe('repository Shader budget verification', () => {
  it('creates exact per-Pass/platform declared and kept baselines', async () => {
    const { root } = await fixture();
    const contract = parseShaderBudgetContract(contractValue());
    const report = await evaluateShaderBudgets(contract, root);

    expect(report).toMatchObject({
      status: 'pass',
      summary: { total: 1, passed: 1, failed: 0, unverified: 0 },
      budgets: [{
        id: 'windows-forward',
        declared: { status: 'pass', count: '6' },
        kept: { status: 'pass', count: '2' },
      }],
    });
    const withBaseline = contractWithCurrentBaselines(contract, report);
    expect(withBaseline.budgets[0].baseline).toMatchObject({
      declared: {
        count: '6',
        contexts: [expect.objectContaining({
          key: expect.stringContaining('Pass 0 Forward | fragment'),
        })],
        keywordSets: expect.arrayContaining([
          expect.objectContaining({ key: expect.stringContaining('QUALITY_LOW') }),
        ]),
      },
      kept: {
        count: '2',
        contexts: [expect.objectContaining({
          key: expect.stringContaining('StandaloneWindows64 | Direct3D11'),
        })],
      },
    });
  });

  it('fails an 800 to 40000 regression with responsible keyword-set deltas', async () => {
    const options = (prefix: string, count: number): string => (
      Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ')
    );
    const before = shaderSource([{
      name: 'Forward',
      pragmas: [
        `#pragma multi_compile_fragment ${options('A', 20)}`,
        `#pragma multi_compile_fragment ${options('B', 40)}`,
      ],
    }]);
    const { root, sourcePath } = await fixture(before);
    const initial = parseShaderBudgetContract(contractValue({
      evidence: undefined,
      limits: { declaredMax: '1000' },
      policy: { contextChanges: 'allow', keywordSetChanges: 'allow' },
    }));
    const baselineReport = await evaluateShaderBudgets(initial, root);
    const baselineContract = contractWithCurrentBaselines(initial, baselineReport);
    const current = shaderSource([{
      name: 'Forward',
      pragmas: [
        `#pragma multi_compile_fragment ${options('A', 40)}`,
        `#pragma multi_compile_fragment ${options('B', 1000)}`,
      ],
    }]);
    await writeFile(sourcePath, current);
    const contract: ShaderBudgetContract = {
      ...baselineContract,
      budgets: baselineContract.budgets.map((budget) => ({
        ...budget,
        limits: {
          ...budget.limits,
          declaredMaxDelta: '100',
        },
      })),
    };

    const report = await evaluateShaderBudgets(contract, root);
    const declared = report.budgets[0].declared;
    expect(report.status).toBe('failed');
    expect(declared).toMatchObject({
      status: 'failed',
      count: '40000',
      baseline: '800',
      delta: '39200',
      violations: expect.arrayContaining([
        'count 40000 exceeds max 1000',
        'delta +39200 exceeds max delta +100',
      ]),
    });
    expect(declared?.keywordSetDeltas).toHaveLength(4);
    const human = formatShaderBudgetReport(report);
    expect(human).toContain('Pass 0 Forward | fragment');
    expect(human).toContain('keyword set:');
    expect(human).toContain('800');
    expect(human).toContain('40000');
  });

  it('marks missing required build evidence as unverified, never as a pass', async () => {
    const { root } = await fixture();
    const contract = parseShaderBudgetContract(contractValue({
      evidence: 'evidence/missing.json',
      limits: { keptMax: '2' },
    }));

    const report = await evaluateShaderBudgets(contract, root);
    expect(report).toMatchObject({
      status: 'unverified',
      summary: { passed: 0, failed: 0, unverified: 1 },
      budgets: [{
        status: 'unverified',
        kept: {
          status: 'unverified',
          reason: expect.stringContaining('cannot be read'),
        },
      }],
    });
    expect(formatShaderBudgetReport(report)).toContain('UNVERIFIED');
  });

  it('allows a kept-count delta within its threshold when Context identity is stable', async () => {
    const source = shaderSource();
    const { root, evidencePath } = await fixture(source);
    const initial = parseShaderBudgetContract(contractValue({
      limits: { keptMax: '4' },
    }));
    const baseline = contractWithCurrentBaselines(
      initial,
      await evaluateShaderBudgets(initial, root),
    );
    const original = completedEvidence(source);
    const changed: VariantBuildEvidence = {
      ...original,
      contexts: original.contexts.map((context, index) => index === 0
        ? {
            ...context,
            kept: { availability: 'available', count: '3' },
          }
        : context),
    };
    await writeFile(evidencePath, `${JSON.stringify(changed, null, 2)}\n`);
    const contract: ShaderBudgetContract = {
      ...baseline,
      budgets: baseline.budgets.map((budget) => ({
        ...budget,
        limits: { ...budget.limits, keptMaxDelta: '1' },
      })),
    };

    const report = await evaluateShaderBudgets(contract, root);
    expect(report).toMatchObject({
      status: 'pass',
      budgets: [{
        kept: {
          status: 'pass',
          count: '3',
          baseline: '2',
          delta: '1',
          contextDeltas: [
            expect.objectContaining({ before: '2', after: '3', delta: '1' }),
          ],
        },
      }],
    });
  });

  it('fails deterministic baseline drift for added and removed source Contexts', async () => {
    const onePass = shaderSource([{ name: 'Forward' }]);
    const { root, sourcePath } = await fixture(onePass);
    const initial = parseShaderBudgetContract(contractValue({
      evidence: undefined,
      selector: { shaderName: 'Tests/Budget', stage: 'fragment' },
      limits: { declaredMax: '10' },
    }));
    const baseline = contractWithCurrentBaselines(
      initial,
      await evaluateShaderBudgets(initial, root),
    );

    await writeFile(sourcePath, shaderSource([
      { name: 'Forward' },
      { name: 'ShadowCaster' },
    ]));
    const added = await evaluateShaderBudgets(baseline, root);
    expect(added).toMatchObject({
      status: 'failed',
      budgets: [{
        declared: {
          contextDeltas: [
            expect.objectContaining({ before: null, after: '3' }),
          ],
        },
      }],
    });

    const twoPassBaseline = contractWithCurrentBaselines(
      initial,
      await evaluateShaderBudgets(initial, root),
    );
    await writeFile(sourcePath, onePass);
    const removed = await evaluateShaderBudgets(twoPassBaseline, root);
    expect(removed).toMatchObject({
      status: 'failed',
      budgets: [{
        declared: {
          contextDeltas: [
            expect.objectContaining({ before: '3', after: null }),
          ],
        },
      }],
    });
  });

  it('produces byte-stable machine and human output', async () => {
    const { root } = await fixture();
    const contract = parseShaderBudgetContract(contractValue());
    const first = await evaluateShaderBudgets(contract, root);
    const second = await evaluateShaderBudgets(contract, root);

    expect(JSON.stringify(first, null, 2)).toBe(JSON.stringify(second, null, 2));
    expect(formatShaderBudgetReport(first)).toBe(formatShaderBudgetReport(second));
    expect(JSON.stringify(first)).not.toContain(root);
    expect(JSON.stringify(first)).not.toContain('generatedAt');
  });

  it('rejects malformed and duplicate contracts while delta awaits baseline', async () => {
    expect(() => parseShaderBudgetContract({
      schemaVersion: 1,
      budgets: [],
    })).toThrow('at least one budget');
    const candidate = contractValue() as { budgets: unknown[] };
    expect(() => parseShaderBudgetContract({
      schemaVersion: 1,
      budgets: [
        candidate.budgets[0],
        candidate.budgets[0],
      ],
    })).toThrow('duplicate id');
    const delta = parseShaderBudgetContract(contractValue({
      evidence: undefined,
      limits: { declaredMaxDelta: '1' },
    }));
    const { root } = await fixture();
    const report = await evaluateShaderBudgets(delta, root);
    expect(report).toMatchObject({
      status: 'unverified',
      budgets: [{
        declared: {
          status: 'unverified',
          reason: expect.stringContaining('baseline is required'),
          snapshot: { count: '6' },
        },
      }],
    });
    expect(
      contractWithCurrentBaselines(delta, report).budgets[0].baseline?.declared?.count,
    ).toBe('6');
    expect(() => parseShaderBudgetContract(contractValue({
      limits: { declaredMax: 6 },
    }))).toThrow('decimal string');
  });
});
