import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MacroPatternRecognizer } from '../../src/macros';
import { indexFile } from '../../src/parser/hlsl';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { UNRESOLVED_ENTRY_POINT_CODE } from '../../src/workspace/diagnostics';
import { createIndexedWorkspaceFixture } from '../helpers/indexedWorkspaceFixture';

function snapshot(uri: string, text: string): IndexedDocumentSnapshot {
  return {
    uri,
    languageId: uri.endsWith('.shader') ? 'shaderlab' : 'hlsl',
    text,
    openId: 1,
    version: 1,
  };
}

describe('unresolved entry-point diagnostics', () => {
  it('reports every supported Shader and Compute pragma reference', async () => {
    const uri = 'file:///project/Assets/All.shader';
    const text = [
      'Shader "Diagnostics/All" {',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    #pragma vertex MissingVertex',
      '    #pragma fragment MissingFragment',
      '    #pragma geometry MissingGeometry',
      '    #pragma hull MissingHull',
      '    #pragma domain MissingDomain',
      '    #pragma surface MissingSurface Standard',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');
    const computeUri = 'file:///project/Assets/Missing.compute';
    const compute = '#pragma kernel MissingKernel';
    const recognizer = new MacroPatternRecognizer([]);
    const indexes = await Promise.all([
      indexFile(uri, text, recognizer),
      indexFile(computeUri, compute, recognizer),
    ]);
    const workspace = createIndexedWorkspaceFixture(indexes);

    const shaderDiagnostics = await workspace.diagnosticsAt(snapshot(uri, text));
    const computeDiagnostics = await workspace.diagnosticsAt(snapshot(computeUri, compute));

    expect(shaderDiagnostics).toHaveLength(6);
    expect(shaderDiagnostics?.map((diagnostic) => diagnostic.code)).toEqual(
      Array(6).fill(UNRESOLVED_ENTRY_POINT_CODE),
    );
    expect(computeDiagnostics).toEqual([
      expect.objectContaining({
        code: UNRESOLVED_ENTRY_POINT_CODE,
        message: expect.stringContaining('MissingKernel'),
      }),
    ]);
  });

  it('accepts same-file functions, ambiguity, variant branches, and macros', async () => {
    const uri = 'file:///project/Assets/Conservative.shader';
    const text = [
      'Shader "Diagnostics/Conservative" {',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    #pragma vertex vert',
      '    #pragma fragment FRAGMENT_ENTRY',
      '    #if FIRST_VARIANT',
      '    float4 vert(float4 value : POSITION) : SV_POSITION { return value; }',
      '    #else',
      '    float4 vert(float4 value : POSITION) : SV_POSITION { return value * 2; }',
      '    #endif',
      '    #define FRAGMENT_ENTRY frag',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([
      await indexFile(uri, text, new MacroPatternRecognizer([])),
    ]);

    await expect(workspace.diagnosticsAt(snapshot(uri, text))).resolves.toEqual([]);
  });

  it('uses the transitive include closure and rejects unrelated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-diagnostics-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainUri = pathToFileURL(join(assets, 'Main.hlsl')).href;
      const includedUri = pathToFileURL(join(assets, 'Included.hlsl')).href;
      const unrelatedUri = pathToFileURL(join(assets, 'Unrelated.hlsl')).href;
      const main = [
        '#include "Included.hlsl"',
        '#pragma vertex IncludedMain',
        '#pragma fragment UnrelatedMain',
      ].join('\n');
      const included = 'float4 IncludedMain(float4 value) { return value; }';
      const unrelated = 'float4 UnrelatedMain(float4 value) { return value; }';
      await Promise.all([
        writeFile(join(assets, 'Main.hlsl'), main, 'utf8'),
        writeFile(join(assets, 'Included.hlsl'), included, 'utf8'),
        writeFile(join(assets, 'Unrelated.hlsl'), unrelated, 'utf8'),
      ]);
      const recognizer = new MacroPatternRecognizer([]);
      const workspace = createIndexedWorkspaceFixture(
        await Promise.all([
          indexFile(mainUri, main, recognizer),
          indexFile(includedUri, included, recognizer),
          indexFile(unrelatedUri, unrelated, recognizer),
        ]),
        { includeCtx: { unityProjectRoot: root, includeDirectories: [] } },
      );

      await expect(workspace.diagnosticsAt(snapshot(mainUri, main))).resolves.toEqual([
        expect.objectContaining({ message: expect.stringContaining('UnrelatedMain') }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores pragma-looking text outside indexed code', async () => {
    const uri = 'file:///project/Assets/Comments.shader';
    const text = [
      'Shader "Diagnostics/Comments" {',
      '  // #pragma vertex CommentedOut',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    /* #pragma fragment BlockCommented */',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([
      await indexFile(uri, text, new MacroPatternRecognizer([])),
    ]);

    await expect(workspace.diagnosticsAt(snapshot(uri, text))).resolves.toEqual([]);
  });
});
