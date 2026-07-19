import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { PackageContext } from '../../src/packages';
import { UnityProjectFacts } from '../../src/project';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { IndexedRevisionBuilder } from '../../src/workspace/indexedRevision';
import { PORTABILITY_DIAGNOSTIC_SOURCE } from '../../src/portability';
import { portabilityTargetStore } from '../../src/portability/targetStore';

describe('Published revision portability report', () => {
  it('derives Unity and URP versions from the same published revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-portability-'));
    const uri = pathToFileURL(join(root, 'Assets', 'Unlit.shader')).href;
    const document: IndexedDocumentSnapshot = {
      uri,
      languageId: 'shaderlab',
      text: [
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
      ].join('\n'),
      openId: 3,
      version: 8,
    };

    try {
      await mkdir(join(root, 'Assets'), { recursive: true });
      await mkdir(join(
        root,
        'Library',
        'PackageCache',
        'com.unity.render-pipelines.universal@14.0.11',
      ), { recursive: true });
      await mkdir(join(root, 'Packages'), { recursive: true });
      await writeFile(join(root, 'Packages', 'manifest.json'), '{"dependencies":{}}\n');
      await writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
        dependencies: {
          'com.unity.render-pipelines.universal': {
            version: '14.0.11',
            source: 'registry',
          },
        },
      }));
      await writeFile(join(
        root,
        'Library',
        'PackageCache',
        'com.unity.render-pipelines.universal@14.0.11',
        'package.json',
      ), JSON.stringify({
        name: 'com.unity.render-pipelines.universal',
        version: '14.0.11',
      }));
      const packages = await PackageContext.load(root, DEFAULT_SETTINGS);
      const builder = IndexedRevisionBuilder.create({
        folderUri: pathToFileURL(root).href,
        settings: DEFAULT_SETTINGS,
        unityRoot: root,
        packages,
        project: UnityProjectFacts.fromProjectVersionText(
          'm_EditorVersion: 2022.3.62f1\n',
        ),
        cache: undefined,
        fingerprint: undefined,
      });
      const prepared = await builder.prepareDocument(document, () => true);
      if (!prepared || !builder.commitDocument(document, prepared, () => true)) {
        throw new Error('failed to publish fixture document');
      }
      const revision = builder.publish(5);

      const report = revision.portabilityReport({
        document,
        target: { kind: 'render-pipeline', pipeline: 'universal' },
      });

      expect(report?.environment).toEqual({
        unityVersion: '2022.3.62f1',
        renderPipelinePackage: {
          name: 'com.unity.render-pipelines.universal',
          version: '14.0.11',
          source: 'registry',
          official: true,
        },
      });
      expect(report?.findings.some((finding) => finding.safeFix)).toBe(true);

      portabilityTargetStore.set(uri, {
        kind: 'render-pipeline',
        pipeline: 'universal',
      });
      const diagnostics = (await revision.diagnostics(document)).filter((diagnostic) => (
        diagnostic.source === PORTABILITY_DIAGNOSTIC_SOURCE
      ));
      const actions = revision.codeActions({
        document,
        range: {
          start: { line: 0, character: 0 },
          end: { line: document.text.split('\n').length, character: 0 },
        },
        context: { diagnostics },
      });
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(actions.length).toBe(diagnostics.length);
      expect(actions.every((action) => action.kind === 'quickfix')).toBe(true);
    } finally {
      portabilityTargetStore.delete(uri);
      await rm(root, { recursive: true, force: true });
    }
  });
});
