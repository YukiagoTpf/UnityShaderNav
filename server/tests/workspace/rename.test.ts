import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { SymbolEntry } from '@unity-shader-nav/shared';
import { GlobalReferenceIndex, IndexStore } from '../../src/index';
import { MacroPatternRecognizer } from '../../src/macros';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';
import { uriKey } from '../../src/uriKey';
import type {
  IndexedDocumentSnapshot,
  RenameFailure,
} from '../../src/workspace/indexedWorkspace';
import { createIndexedWorkspaceFixture } from '../helpers/indexedWorkspaceFixture';
import { renameWorkspaceSymbol } from '../../src/workspace/rename';

function snapshot(uri: string, text: string): IndexedDocumentSnapshot {
  return { uri, languageId: 'hlsl', text, openId: 1, version: 1 };
}

function positionOf(text: string, token: string, occurrence = 0) {
  const lines = text.split(/\r?\n/);
  let seen = 0;
  for (let line = 0; line < lines.length; line++) {
    let from = 0;
    while (true) {
      const character = lines[line].indexOf(token, from);
      if (character < 0) break;
      if (seen++ === occurrence) return { line, character: character + 1 };
      from = character + token.length;
    }
  }
  throw new Error(`missing token ${token} occurrence ${occurrence}`);
}

function failureMessage(value: unknown): string {
  return (value as RenameFailure).message;
}

describe('Workspace Rename', () => {
  it('renames one include-visible function across its declaration, pragma, and call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-rename-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const libUri = pathToFileURL(join(assets, 'Lib.hlsl')).href;
      const mainUri = pathToFileURL(join(assets, 'Main.hlsl')).href;
      const libText = 'float4 Helper(float4 value) { return value; }';
      const mainText = [
        '#include "Lib.hlsl"',
        '#pragma vertex Helper',
        'float4 Main() { return Helper(1); }',
      ].join('\n');
      await writeFile(join(assets, 'Lib.hlsl'), libText, 'utf8');
      await writeFile(join(assets, 'Main.hlsl'), mainText, 'utf8');
      const recognizer = new MacroPatternRecognizer([]);
      const workspace = createIndexedWorkspaceFixture(
        await Promise.all([
          indexFile(libUri, libText, recognizer),
          indexFile(mainUri, mainText, recognizer),
        ]),
        { includeCtx: { unityProjectRoot: root, includeDirectories: [] } },
      );
      const document = snapshot(mainUri, mainText);
      const position = positionOf(mainText, 'Helper', 1);

      await expect(workspace.prepareRenameAt({ document, position })).resolves.toEqual({
        kind: 'ready',
        range: expect.any(Object),
        placeholder: 'Helper',
      });
      const edit = await workspace.renameAt({ document, position, newName: 'VertexMain' });

      expect(edit).toEqual({
        changes: {
          [libUri]: [{ range: expect.any(Object), newText: 'VertexMain' }],
          [mainUri]: [
            { range: expect.any(Object), newText: 'VertexMain' },
            { range: expect.any(Object), newText: 'VertexMain' },
          ],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renames only the nearest scoped declaration and its references', async () => {
    const uri = 'file:///project/Scoped.hlsl';
    const text = [
      'float4 First(float4 value) { return value; }',
      'float4 Second(float4 value) { return value; }',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    const document = snapshot(uri, text);
    const edit = await workspace.renameAt({
      document,
      position: positionOf(text, 'value', 1),
      newName: 'firstValue',
    });

    expect(edit && 'changes' in edit ? edit.changes?.[uri] : undefined).toHaveLength(2);
    expect(edit && 'changes' in edit ? edit.changes?.[uri] : undefined).toEqual([
      { range: expect.objectContaining({ start: { line: 0, character: 20 } }), newText: 'firstValue' },
      { range: expect.objectContaining({ start: { line: 0, character: 36 } }), newText: 'firstValue' },
    ]);
  });

  it('renames a resolved struct member without touching unrelated identifiers', async () => {
    const uri = 'file:///project/Member.hlsl';
    const text = [
      'struct Data { float4 color; };',
      'float4 Use(Data data) { return data.color; }',
      'float4 color;',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    const edit = await workspace.renameAt({
      document: snapshot(uri, text),
      position: positionOf(text, 'color', 1),
      newName: 'tint',
    });

    expect(edit && 'changes' in edit ? edit.changes?.[uri] : undefined).toHaveLength(2);
  });

  it('renames a struct method without touching the same method name on another type', async () => {
    const uri = 'file:///project/Method.hlsl';
    const text = [
      'struct Surface { float Shade(float x) { return x; } };',
      'struct Light { float Shade(float x) { return x; } };',
      'float Use(Surface surface, Light light) { return surface.Shade(1) + light.Shade(2); }',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    const edit = await workspace.renameAt({
      document: snapshot(uri, text),
      position: positionOf(text, 'Shade', 2),
      newName: 'Evaluate',
    });

    const changes = edit && 'changes' in edit ? edit.changes?.[uri] : undefined;
    expect(changes).toEqual([
      { range: expect.objectContaining({ start: { line: 0, character: 23 } }), newText: 'Evaluate' },
      { range: expect.objectContaining({ start: { line: 2, character: 57 } }), newText: 'Evaluate' },
    ]);
  });

  it('renames one logical method symmetrically from its declaration, definition, and call', async () => {
    const uri = 'file:///project/DeclaredMethod.hlsl';
    const text = [
      'struct Surface { float Shade(float x); };',
      'float Surface::Shade(float x) { return x; }',
      'float Use(Surface surface) { return surface.Shade(1); }',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    for (const occurrence of [0, 1, 2]) {
      const edit = await workspace.renameAt({
        document: snapshot(uri, text),
        position: positionOf(text, 'Shade', occurrence),
        newName: 'Evaluate',
      });

      expect(edit && 'changes' in edit ? edit.changes?.[uri] : undefined).toHaveLength(3);
    }
  });

  it('does not rename the same method signature in an unrelated file', async () => {
    const firstUri = 'file:///project/A.hlsl';
    const secondUri = 'file:///project/B.hlsl';
    const methodText = [
      'struct Surface { float Shade(float x); };',
      'float Surface::Shade(float x) { return x; }',
      'float Use(Surface surface) { return surface.Shade(1); }',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([
      await indexFile(firstUri, methodText),
      await indexFile(secondUri, methodText),
    ]);
    const edit = await workspace.renameAt({
      document: snapshot(firstUri, methodText),
      position: positionOf(methodText, 'Shade', 2),
      newName: 'Evaluate',
    });

    expect(edit && 'changes' in edit ? edit.changes : undefined).toEqual({
      [firstUri]: [
        { range: expect.any(Object), newText: 'Evaluate' },
        { range: expect.any(Object), newText: 'Evaluate' },
        { range: expect.any(Object), newText: 'Evaluate' },
      ],
    });
  });

  it('renames a macro declaration and compatible call references', async () => {
    const uri = 'file:///project/Macro.hlsl';
    const text = [
      '#define SCALE(x) ((x) * 2)',
      'float Use() { return SCALE(1); }',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    const edit = await workspace.renameAt({
      document: snapshot(uri, text),
      position: positionOf(text, 'SCALE', 1),
      newName: 'DOUBLE_VALUE',
    });

    expect(edit && 'changes' in edit ? edit.changes?.[uri] : undefined).toEqual([
      { range: expect.any(Object), newText: 'DOUBLE_VALUE' },
      { range: expect.any(Object), newText: 'DOUBLE_VALUE' },
    ]);
  });

  it('refuses ambiguous overloads instead of renaming every same-name function', async () => {
    const uri = 'file:///project/Ambiguous.hlsl';
    const text = [
      'float Helper(float value) { return value; }',
      'float2 Helper(float2 value) { return value; }',
      'float Main() { return Helper(1); }',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    const outcome = await workspace.prepareRenameAt({
      document: snapshot(uri, text),
      position: positionOf(text, 'Helper', 2),
    });

    expect(failureMessage(outcome)).toContain('ambiguous');
  });

  it('fails closed when the prepared declaration disappears before edit collection', async () => {
    const uri = 'file:///project/Diverged.hlsl';
    const text = 'float Main() { return Helper(); }';
    const declarationUri = 'file:///project/Library.hlsl';
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    const globalRefs = new GlobalReferenceIndex();
    store.set(uri, index);
    globalRefs.upsert(index);
    const declaration: SymbolEntry = {
      name: 'Helper',
      kind: 'function',
      returnType: 'float',
      parameters: [],
      location: {
        uri: declarationUri,
        range: { start: { line: 5, character: 0 }, end: { line: 5, character: 6 } },
      },
    };
    let helperLookups = 0;
    const global = {
      lookup(name: string): SymbolEntry[] {
        if (name !== 'Helper') return [];
        return helperLookups++ === 0 ? [declaration] : [];
      },
      *entries(): IterableIterator<SymbolEntry> {},
    };

    const outcome = await renameWorkspaceSymbol({
      index: { store, global, globalRefs },
      includeChain: {
        resolve: async () => null,
        visibleUriKeys: async () => new Set([uriKey(uri), uriKey(declarationUri)]),
      },
      isInPackages: () => false,
      includePackages: false,
      definitionTrace: false,
    }, {
      document: snapshot(uri, text),
      position: positionOf(text, 'Helper'),
      newName: 'RenamedHelper',
    });

    expect(outcome).toEqual({
      kind: 'failure',
      message: expect.stringContaining('No editable occurrences'),
    });
    expect(helperLookups).toBeGreaterThan(1);
  });

  it('refuses built-ins, include paths, invalid names, and global collisions', async () => {
    const uri = 'file:///project/Refusals.hlsl';
    const text = [
      '#include "Other.hlsl"',
      'float4 Existing() { return 1; }',
      'float4 Current() { return normalize(Existing()); }',
    ].join('\n');
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    const document = snapshot(uri, text);

    expect(failureMessage(await workspace.prepareRenameAt({
      document,
      position: positionOf(text, 'normalize'),
    }))).toContain('built-in');
    expect(failureMessage(await workspace.prepareRenameAt({
      document,
      position: positionOf(text, 'Other.hlsl'),
    }))).toContain('Include paths');
    expect(failureMessage(await workspace.renameAt({
      document,
      position: positionOf(text, 'Current'),
      newName: '1invalid',
    }))).toContain('valid HLSL identifier');
    expect(failureMessage(await workspace.renameAt({
      document,
      position: positionOf(text, 'Current'),
      newName: 'Existing',
    }))).toContain('conflicts');
  });

  it('refuses Package declarations and Property-linked HLSL variables', async () => {
    const packageUri = 'file:///project/Packages/com.example/Shared.hlsl';
    const packageText = 'float4 PackageHelper() { return 1; }';
    const packageWorkspace = createIndexedWorkspaceFixture(
      [await indexFile(packageUri, packageText)],
      { isInPackages: (uri) => uri === packageUri },
    );
    expect(failureMessage(await packageWorkspace.prepareRenameAt({
      document: snapshot(packageUri, packageText),
      position: positionOf(packageText, 'PackageHelper'),
    }))).toContain('read-only');

    const shaderUri = 'file:///project/Assets/Linked.shader';
    const shaderText = [
      'Shader "Linked" {',
      '  Properties {',
      '    _Color ("Color", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 _Color;',
      '      float4 frag() : SV_Target { return _Color; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const shaderWorkspace = createIndexedWorkspaceFixture([
      await indexFile(shaderUri, shaderText),
    ]);
    expect(failureMessage(await shaderWorkspace.prepareRenameAt({
      document: { ...snapshot(shaderUri, shaderText), languageId: 'shaderlab' },
      position: positionOf(shaderText, '_Color', 1),
    }))).toContain('cross-contract rename');
  });
});
