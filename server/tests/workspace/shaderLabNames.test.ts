import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  type FileIndex,
} from '@unity-shader-nav/shared';
import { MacroPatternRecognizer } from '../../src/macros';
import { PackageContext } from '../../src/packages';
import { indexFile } from '../../src/parser/hlsl';
import type {
  IndexedDocumentSnapshot,
  RenameFailure,
} from '../../src/workspace/indexedWorkspace';
import {
  IndexedRevisionBuilder,
  type PublishedIndexedRevision,
} from '../../src/workspace/indexedRevision';
import { createIndexedWorkspaceFixture } from '../helpers/indexedWorkspaceFixture';
import { createTestWorkspaceLocation } from '../helpers/testWorkspaceLocation';

const workspaceLocation = createTestWorkspaceLocation('usn-shaderlab-names');

function snapshot(uri: string, text: string): IndexedDocumentSnapshot {
  return { uri, text, languageId: 'shaderlab', openId: 1, version: 1 };
}

function positionOf(text: string, token: string, occurrence = 0) {
  let offset = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(token, from);
    if (offset < 0) throw new Error(`missing ${token} occurrence ${occurrence}`);
    from = offset + token.length;
  }
  const before = text.slice(0, offset).split('\n');
  return { line: before.length - 1, character: before.at(-1)!.length + 1 };
}

async function publish(files: ReadonlyArray<{ uri: string; text: string }>) {
  const recognizer = new MacroPatternRecognizer(DEFAULT_SETTINGS.declarationMacros);
  const indexes = await Promise.all(
    files.map(({ uri, text }) => indexFile(uri, text, recognizer)),
  );
  return publishIndexes(indexes);
}

function publishIndexes(indexes: readonly FileIndex[]): PublishedIndexedRevision {
  const builder = IndexedRevisionBuilder.create({
    folderUri: workspaceLocation.folderUri,
    settings: DEFAULT_SETTINGS,
    unityRoot: undefined,
    packages: PackageContext.standalone(DEFAULT_SETTINGS),
    cache: undefined,
    fingerprint: undefined,
  });
  for (const index of indexes) builder.restoreFromCache(index.uri, index);
  return builder.publish(1);
}

function failureMessage(value: unknown): string {
  return (value as RenameFailure).message;
}

describe('ShaderLab name semantics', () => {
  it('connects Shader declarations with Fallback and UsePass shader paths', async () => {
    const libraryUri = workspaceLocation.fileUri('Assets', 'Library.shader');
    const consumerUri = workspaceLocation.fileUri('Assets', 'Consumer.shader');
    const library = [
      'Shader "Library/Lit" {',
      '  SubShader { Pass { Name "FORWARD" } }',
      '}',
    ].join('\n');
    const consumer = [
      'Shader "Game/Consumer" {',
      '  Fallback "Library/Lit"',
      '  SubShader {',
      '    UsePass "Library/Lit/FORWARD"',
      '  }',
      '}',
    ].join('\n');
    const revision = await publish([
      { uri: libraryUri, text: library },
      { uri: consumerUri, text: consumer },
    ]);
    const document = snapshot(consumerUri, consumer);
    const fallback = positionOf(consumer, 'Library/Lit');

    const definitions = await revision.definitionAt({ document, position: fallback });
    expect(definitions).toHaveLength(1);
    expect(definitions?.[0]).toMatchObject({ targetUri: libraryUri });
    await expect(revision.referencesAt({
      document,
      position: fallback,
      includeDeclaration: true,
    })).resolves.toHaveLength(3);
    await expect(revision.hoverAt({ document, position: fallback })).resolves.toMatchObject({
      contents: { value: '`Shader "Library/Lit"`' },
    });

    const completionText = [
      'Shader "Game/New" {',
      '  Fallback "Library/',
      '}',
    ].join('\n');
    const completions = await revision.completionAt({
      document: snapshot(consumerUri, completionText),
      position: { line: 1, character: '  Fallback "Library/'.length },
    });
    expect(completions?.map((item) => item.label)).toContain('Library/Lit');
    expect(revision.workspaceSymbols('Library')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Library/Lit' }),
    ]));

    const edit = await revision.renameAt({
      document,
      position: fallback,
      newName: 'Library/AdvancedLit',
    });
    expect(edit && 'changes' in edit ? edit.changes?.[libraryUri] : undefined).toHaveLength(1);
    expect(edit && 'changes' in edit ? edit.changes?.[consumerUri] : undefined).toEqual([
      { range: expect.any(Object), newText: 'Library/AdvancedLit' },
      { range: expect.any(Object), newText: 'Library/AdvancedLit' },
    ]);
  });

  it('connects Pass Name with UsePass and canonicalizes renamed references', async () => {
    const libraryUri = workspaceLocation.fileUri('Assets', 'Library.shader');
    const consumerUri = workspaceLocation.fileUri('Assets', 'Consumer.shader');
    const library = [
      'Shader "Library/Lit" {',
      '  SubShader {',
      '    Pass { Name "ForwardLit" }',
      '  }',
      '}',
    ].join('\n');
    const consumer = [
      'Shader "Game/Consumer" {',
      '  SubShader {',
      '    UsePass "Library/Lit/FORWARDLIT"',
      '  }',
      '}',
    ].join('\n');
    const revision = await publish([
      { uri: libraryUri, text: library },
      { uri: consumerUri, text: consumer },
    ]);
    const document = snapshot(consumerUri, consumer);
    const pass = positionOf(consumer, 'FORWARDLIT');

    const definitions = await revision.definitionAt({ document, position: pass });
    expect(definitions).toHaveLength(1);
    expect(definitions?.[0]).toMatchObject({ targetUri: libraryUri });
    await expect(revision.referencesAt({
      document,
      position: pass,
      includeDeclaration: true,
    })).resolves.toHaveLength(2);
    await expect(revision.hoverAt({ document, position: pass })).resolves.toMatchObject({
      contents: { value: expect.stringContaining('Library/Lit') },
    });

    const completionText = [
      'Shader "Game/New" {',
      '  SubShader {',
      '    UsePass "Library/Lit/FOR',
      '  }',
      '}',
    ].join('\n');
    const completions = await revision.completionAt({
      document: snapshot(consumerUri, completionText),
      position: { line: 2, character: '    UsePass "Library/Lit/FOR'.length },
    });
    expect(completions?.map((item) => item.label)).toContain('FORWARDLIT');
    expect(revision.workspaceSymbols('Forward')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ForwardLit', containerName: 'Library/Lit' }),
    ]));

    const edit = await revision.renameAt({
      document,
      position: pass,
      newName: 'DepthOnly',
    });
    expect(edit && 'changes' in edit ? edit.changes?.[libraryUri] : undefined).toEqual([
      { range: expect.any(Object), newText: 'DepthOnly' },
    ]);
    expect(edit && 'changes' in edit ? edit.changes?.[consumerUri] : undefined).toEqual([
      { range: expect.any(Object), newText: 'DEPTHONLY' },
    ]);
  });

  it('returns every duplicate declaration but refuses an unsafe Rename', async () => {
    const firstUri = workspaceLocation.fileUri('Assets', 'First.shader');
    const secondUri = workspaceLocation.fileUri('Assets', 'Second.shader');
    const consumerUri = workspaceLocation.fileUri('Assets', 'Consumer.shader');
    const duplicate = ['Shader "Duplicate/Name" {', '  SubShader {}', '}'].join('\n');
    const consumer = [
      'Shader "Consumer" {',
      '  Fallback "Duplicate/Name"',
      '}',
    ].join('\n');
    const revision = await publish([
      { uri: firstUri, text: duplicate },
      { uri: secondUri, text: duplicate },
      { uri: consumerUri, text: consumer },
    ]);
    const document = snapshot(consumerUri, consumer);
    const position = positionOf(consumer, 'Duplicate/Name');

    await expect(revision.definitionAt({ document, position })).resolves.toHaveLength(2);
    expect(failureMessage(await revision.prepareRenameAt({ document, position }))).toContain(
      'ambiguous',
    );
  });

  it('uses the latest open-document name facts', async () => {
    const uri = workspaceLocation.fileUri('Assets', 'Live.shader');
    const text = [
      'Shader "Live/Edited" {',
      '  SubShader {',
      '    Pass {',
      '      Name "LIVEPASS"',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const builder = IndexedRevisionBuilder.create({
      folderUri: workspaceLocation.folderUri,
      settings: DEFAULT_SETTINGS,
      unityRoot: undefined,
      packages: PackageContext.standalone(DEFAULT_SETTINGS),
      cache: undefined,
      fingerprint: undefined,
    });
    const candidate = await builder.prepareDocument(document, () => true);
    expect(candidate).not.toBeNull();
    expect(builder.commitDocument(document, candidate!, () => true)).toBe(true);
    const revision = builder.publish(1);

    expect(revision.workspaceSymbols('Live')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Live/Edited' }),
      expect.objectContaining({ name: 'LIVEPASS' }),
    ]));
  });

  it('keeps Package declarations navigable but read-only', async () => {
    const packageUri = workspaceLocation.fileUri(
      'Packages',
      'com.example',
      'Library.shader',
    );
    const consumerUri = workspaceLocation.fileUri('Assets', 'Consumer.shader');
    const packageText = [
      'Shader "Package/Library" {',
      '  SubShader {}',
      '}',
    ].join('\n');
    const consumer = [
      'Shader "Consumer" {',
      '  Fallback "Package/Library"',
      '}',
    ].join('\n');
    const recognizer = new MacroPatternRecognizer(DEFAULT_SETTINGS.declarationMacros);
    const workspace = createIndexedWorkspaceFixture(
      await Promise.all([
        indexFile(packageUri, packageText, recognizer),
        indexFile(consumerUri, consumer, recognizer),
      ]),
      { isInPackages: (uri) => uri === packageUri },
    );
    const document = snapshot(consumerUri, consumer);
    const position = positionOf(consumer, 'Package/Library');

    await expect(workspace.definitionAt({ document, position })).resolves.toEqual([
      expect.objectContaining({ targetUri: packageUri }),
    ]);
    expect(failureMessage(await workspace.prepareRenameAt({ document, position }))).toContain(
      'read-only',
    );
  });

  it('keeps unresolved external names neutral', async () => {
    const uri = workspaceLocation.fileUri('Assets', 'External.shader');
    const text = [
      'Shader "Consumer" {',
      '  Fallback "Hidden/ExternalShader"',
      '}',
    ].join('\n');
    const revision = await publish([{ uri, text }]);
    const document = snapshot(uri, text);
    const position = positionOf(text, 'Hidden/ExternalShader');

    await expect(revision.definitionAt({ document, position })).resolves.toBeNull();
    await expect(revision.hoverAt({ document, position })).resolves.toBeNull();
    await expect(revision.referencesAt({
      document,
      position,
      includeDeclaration: true,
    })).resolves.toBeNull();
    expect(failureMessage(await revision.prepareRenameAt({ document, position }))).toContain(
      'no indexed declaration',
    );
  });
});
