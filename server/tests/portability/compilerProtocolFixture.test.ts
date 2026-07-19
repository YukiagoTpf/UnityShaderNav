import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AdapterDiagnostic,
  CompileProfile,
  Range,
} from '@unity-shader-nav/shared';
import {
  ADAPTER_INTERFACE_VERSION,
  SHADER_MESSAGES_CAPABILITY,
} from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import { shaderSourceHash } from '../../src/handlers/adapterDiagnostics';
import { createPortabilityReport } from '../../src/portability';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'birp-urp-unlit');
const URI = 'file:///project/Assets/UnlitColor.shader';
const PROFILE: CompileProfile = {
  name: 'Windows Vulkan',
  platform: 'StandaloneWindows64',
  graphicsApi: 'Vulkan',
  capability: 'compile-profile/windows-vulkan',
};

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

describe('BiRP-to-URP unlit Adapter protocol fixture', () => {
  it('binds separate pre-fix and post-fix profile results to exact source hashes', async () => {
    const before = (await readFile(join(FIXTURE_DIR, 'before.shader'), 'utf8')).trimEnd();
    const after = (await readFile(join(FIXTURE_DIR, 'after.shader'), 'utf8')).trimEnd();
    let compiledSource = before;
    let collectedAt = 1_000;
    const registry = new AdapterRegistry({
      now: () => 2_000,
      profileSource: { getCompileProfiles: async () => [PROFILE] },
      messageSource: {
        getShaderMessages: async (): Promise<readonly AdapterDiagnostic[]> => [{
          shaderMessage: {
            message: 'protocol fixture warning',
            severity: 'warning',
          },
          provenance: {
            capability: SHADER_MESSAGES_CAPABILITY,
            adapterVersion: 'fixture-adapter',
            unityVersion: '2022.3.62f1',
            projectId: 'fixture-project',
            instanceId: 'fixture-instance',
            collectedAt: collectedAt++,
            sourceRevision: {
              uri: URI,
              assetGuid: 'fixture-guid',
              contentHash: shaderSourceHash(compiledSource),
            },
          },
        }],
      },
    });
    registry.registerHandshake('fixture-project', {
      interfaceVersion: ADAPTER_INTERFACE_VERSION,
      issuedAt: 2_000,
      instanceId: 'fixture-instance',
      capabilities: {
        unityVersion: '2022.3.62f1',
        projectId: 'fixture-project',
        adapterVersion: 'fixture-adapter',
        supportedFeatures: [SHADER_MESSAGES_CAPABILITY, PROFILE.capability],
      },
    });

    const migration = createPortabilityReport({
      uri: URI,
      source: before,
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
    const migrated = applyEdits(before, migration.findings.flatMap((finding) => (
      finding.safeFix?.edits ?? []
    )));
    expect(migrated).toBe(after);

    for (const source of [before, after]) {
      compiledSource = source;
      const result = await registry.shaderMessagesFor(
        URI,
        createHash('sha256').update(source, 'utf8').digest('hex'),
        PROFILE,
      );
      const report = createPortabilityReport({
        uri: URI,
        source,
        target: { kind: 'graphics-profile', profile: PROFILE },
        environment: {
          unityVersion: '2022.3.62f1',
          renderPipelinePackages: [],
        },
        compilerResult: result,
      });

      expect(result.status).toBe('completed');
      expect(report.compilerVerification.status).toBe('passed');
    }
  });
});
