import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  VARIANT_BUILD_EVIDENCE_CAPABILITY,
  type AdapterHandshake,
  type VariantBuildEvidence,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type { VariantBuildEvidenceSource } from '../../src/adapter/variantBuildEvidenceSource';

const NOW = 1_000_000;
const URI = 'file:///project/Assets/Shaders/Lit.shader';
const HASH = '0123456789abcdef';

function handshake(): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: NOW,
    instanceId: 'editor-1',
    capabilities: {
      unityVersion: '6000.0.31f1',
      projectId: 'project-a',
      adapterVersion: '0.3.0',
      supportedFeatures: [VARIANT_BUILD_EVIDENCE_CAPABILITY],
    },
  };
}

function completedEvidence(): VariantBuildEvidence {
  return fixture('before-after-stripping.json');
}

function fixture(name: string): VariantBuildEvidence {
  return JSON.parse(readFileSync(
    join(__dirname, 'fixtures', 'variant-build', name),
    'utf8',
  )) as VariantBuildEvidence;
}

describe('Adapter Variant build evidence', () => {
  it('ingests evidence bound to the current Adapter and saved Shader source', async () => {
    const evidence = completedEvidence();
    const source: VariantBuildEvidenceSource = {
      getVariantBuildEvidence: async (uri) => {
        expect(uri).toBe(URI);
        return evidence;
      },
    };
    const registry = new AdapterRegistry({
      now: () => NOW,
      variantBuildSource: source,
    });
    registry.registerHandshake('project-a', handshake());

    const result = await registry.variantBuildEvidenceFor(URI, HASH);

    expect(result).toEqual({ availability: 'available', evidence });
    if (result.availability === 'available') {
      expect(result.evidence).not.toBe(evidence);
      expect(result.evidence.contexts[0]).not.toBe(evidence.contexts[0]);
    }
  });

  it('preserves compiler candidates from a failed stripping build with explicit status', async () => {
    const evidence = fixture('failed-after-compilation.json');
    const registry = new AdapterRegistry({
      now: () => NOW,
      variantBuildSource: {
        getVariantBuildEvidence: async () => evidence,
      },
    });
    registry.registerHandshake('project-a', handshake());

    await expect(registry.variantBuildEvidenceFor(URI, HASH)).resolves.toEqual({
      availability: 'available',
      evidence,
    });
  });

  it('rejects build evidence collected from an obsolete Shader source revision', async () => {
    const registry = new AdapterRegistry({
      now: () => NOW,
      variantBuildSource: {
        getVariantBuildEvidence: async () => fixture('source-drift.json'),
      },
    });
    registry.registerHandshake('project-a', handshake());

    await expect(registry.variantBuildEvidenceFor(URI, HASH)).resolves.toEqual({
      availability: 'unavailable',
      reason: 'source-drift',
    });
  });

  it('rejects an unbounded Adapter snapshot instead of truncating it into false completeness', async () => {
    const evidence = completedEvidence();
    const oversized: VariantBuildEvidence = {
      ...evidence,
      contexts: Array.from({ length: 2_049 }, () => evidence.contexts[0]),
    };
    const registry = new AdapterRegistry({
      now: () => NOW,
      variantBuildSource: {
        getVariantBuildEvidence: async () => oversized,
      },
    });
    registry.registerHandshake('project-a', handshake());

    await expect(registry.variantBuildEvidenceFor(URI, HASH)).resolves.toEqual({
      availability: 'unavailable',
      reason: 'evidence-limit-exceeded',
    });
  });

  it.each([
    ['foreign project', { projectId: 'project-b' }],
    ['different Editor instance', { instanceId: 'editor-2' }],
    ['different Adapter version', { adapterVersion: '0.4.0' }],
    ['different Unity version', { unityVersion: '2022.3.62f1' }],
    ['missing build target', { buildTarget: '' }],
    ['future collection timestamp', { collectedAt: NOW + 1 }],
  ])('rejects evidence bound to a %s', async (_label, provenanceChange) => {
    const evidence = completedEvidence();
    const changed: VariantBuildEvidence = {
      ...evidence,
      provenance: { ...evidence.provenance, ...provenanceChange },
    };
    const registry = new AdapterRegistry({
      now: () => NOW,
      variantBuildSource: {
        getVariantBuildEvidence: async () => changed,
      },
    });
    registry.registerHandshake('project-a', handshake());

    await expect(registry.variantBuildEvidenceFor(URI, HASH)).resolves.toEqual({
      availability: 'unavailable',
      reason: 'invalid-evidence',
    });
  });

  it.each<Array<[string, (evidence: VariantBuildEvidence) => VariantBuildEvidence]>>([
    ['kept count exceeds compile candidates', (evidence) => ({
      ...evidence,
      contexts: [{
        ...evidence.contexts[0],
        kept: { availability: 'available', count: '13' },
      }],
    })],
    ['keyword-set stage differs from its Context', (evidence) => ({
      ...evidence,
      contexts: [{
        ...evidence.contexts[0],
        keywordSets: [{
          ...evidence.contexts[0].keywordSets[0],
          stage: 'vertex',
        }],
      }],
    })],
  ])('rejects contradictory evidence when %s', async (_label, mutate) => {
    const registry = new AdapterRegistry({
      now: () => NOW,
      variantBuildSource: {
        getVariantBuildEvidence: async () => mutate(completedEvidence()),
      },
    });
    registry.registerHandshake('project-a', handshake());

    await expect(registry.variantBuildEvidenceFor(URI, HASH)).resolves.toEqual({
      availability: 'unavailable',
      reason: 'invalid-evidence',
    });
  });
});
