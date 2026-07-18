import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SETTINGS,
  type ExtensionSettings,
  type FileIndex,
  type SymbolEntry,
} from '@unity-shader-nav/shared';
import {
  DocumentHighlightKind,
  LSPErrorCodes,
  SymbolKind as LspSymbolKind,
  type SemanticTokens,
} from 'vscode-languageserver/node';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { describe, expect, it } from 'vitest';
import { MacroPatternRecognizer } from '../../src/macros';
import { PackageContext } from '../../src/packages';
import { UnityProjectFacts } from '../../src/project';
import { indexFile } from '../../src/parser/hlsl';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import {
  IndexedRevisionBuilder,
  type PublishedIndexedRevision,
} from '../../src/workspace/indexedRevision';
import { SEMANTIC_TOKEN_TYPES } from '../../src/workspace/semanticTokenLegend';
import { WorkspaceManager } from '../../src/workspace/workspaceManager';
import { createCursorRequestFacts } from '../../src/workspace/requestFacts';

const connection = {
  console: { log() {}, warn() {}, error() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

interface TextFile {
  readonly uri: string;
  readonly text: string;
}

function snapshot(
  uri: string,
  text: string,
  languageId = uri.endsWith('.shader') ? 'shaderlab' : 'hlsl',
): IndexedDocumentSnapshot {
  return { uri, text, languageId, openId: 1, version: 1 };
}

function positionOf(
  text: string,
  needle: string,
  occurrence = 0,
  characterOffset = 0,
): { line: number; character: number } {
  let offset = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(needle, from);
    if (offset < 0) throw new Error(`missing occurrence ${occurrence} of ${needle}`);
    from = offset + needle.length;
  }
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return {
    line: lines.length - 1,
    character: lines.at(-1)!.length + characterOffset,
  };
}

function publishIndexes(
  folderUri: string,
  indexes: readonly FileIndex[],
  options: {
    settings?: ExtensionSettings;
    unityRoot?: string;
    packages?: PackageContext;
  } = {},
): PublishedIndexedRevision {
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const builder = IndexedRevisionBuilder.create({
    folderUri,
    settings,
    unityRoot: options.unityRoot,
    packages: options.packages ?? PackageContext.standalone(settings),
    cache: undefined,
    fingerprint: undefined,
  });
  for (const index of indexes) builder.restoreFromCache(index.uri, index);
  return builder.publish(1);
}

async function publishTextFiles(
  folderUri: string,
  files: readonly TextFile[],
): Promise<PublishedIndexedRevision> {
  const table = new MacroPatternRecognizer(DEFAULT_SETTINGS.declarationMacros);
  const indexes = await Promise.all(
    files.map(({ uri, text }) => indexFile(uri, text, table)),
  );
  return publishIndexes(folderUri, indexes);
}

async function publishOpenDocument(
  folderUri: string,
  document: IndexedDocumentSnapshot,
  project = UnityProjectFacts.unknown(),
): Promise<PublishedIndexedRevision> {
  const settings = DEFAULT_SETTINGS;
  const builder = IndexedRevisionBuilder.create({
    folderUri,
    settings,
    unityRoot: undefined,
    packages: PackageContext.standalone(settings),
    project,
    cache: undefined,
    fingerprint: undefined,
  });
  const candidate = await builder.prepareDocument(document, () => true);
  if (!candidate || !builder.commitDocument(document, candidate, () => true)) {
    throw new Error(`failed to prepare ${document.uri}`);
  }
  return builder.publish(1);
}

interface DecodedToken {
  readonly line: number;
  readonly character: number;
  readonly length: number;
  readonly type: string;
}

function decodeTokens(tokens: SemanticTokens): DecodedToken[] {
  const decoded: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    line += tokens.data[index];
    character = tokens.data[index] === 0
      ? character + tokens.data[index + 1]
      : tokens.data[index + 1];
    decoded.push({
      line,
      character,
      length: tokens.data[index + 2],
      type: SEMANTIC_TOKEN_TYPES[tokens.data[index + 3]],
    });
  }
  return decoded;
}

function tokenTexts(text: string, tokens: readonly DecodedToken[]): Array<{
  text: string;
  type: string;
}> {
  const lines = text.split(/\r?\n/);
  return tokens.map((token) => ({
    text: lines[token.line].slice(token.character, token.character + token.length),
    type: token.type,
  }));
}

function expectSortedAndNonOverlapping(tokens: readonly DecodedToken[]): void {
  for (let index = 1; index < tokens.length; index++) {
    const previous = tokens[index - 1];
    const current = tokens[index];
    if (current.line === previous.line) {
      expect(current.character).toBeGreaterThanOrEqual(
        previous.character + previous.length,
      );
    } else {
      expect(current.line).toBeGreaterThan(previous.line);
    }
  }
}

function symbol(
  name: string,
  kind: SymbolEntry['kind'],
  uri: string,
  line: number,
  extras: Partial<SymbolEntry> = {},
): SymbolEntry {
  return {
    name,
    kind,
    location: {
      uri,
      range: {
        start: { line, character: 0 },
        end: { line, character: name.length },
      },
    },
    ...extras,
  };
}

describe('published query behavior', () => {
  it('serves authoring facts only for the exact committed document attempt', async () => {
    const uri = 'file:///project/Assets/Authoring.shader';
    const text = [
      'Shader "Authoring/Test" {',
      '  Properties {',
      '    _Color ("Color", Color) = (1, 0, 0, 1)',
      '  }',
      '  SubShader {}',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const revision = await publishOpenDocument('file:///project', document);

    expect(revision.documentColors({ uri, document })).toHaveLength(1);
    expect(revision.formatDocument({
      document,
      options: { tabSize: 2, insertSpaces: true },
    })).not.toBeNull();

    const stale = { ...document, version: document.version + 1 };
    expect(revision.documentColors({ uri, document: stale })).toEqual([]);
    expect(revision.formatDocument({
      document: stale,
      options: { tabSize: 2, insertSpaces: true },
    })).toBeNull();
  });

  it('serves context-bound ShaderLab and semantic Quick Documentation', async () => {
    const uri = 'file:///project/Assets/Documentation.shader';
    const text = [
      'Shader "Docs/Test" {',
      '  Properties {',
      '    [HDR] _Color ("Color", Color) = (1,1,1,1)',
      '    _MainTex ("Texture", 2D) = "white" {}',
      '  }',
      '  SubShader {',
      '    Cull Back',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 frag() : SV_Target { return 1; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const revision = await publishOpenDocument(
      'file:///project',
      document,
      UnityProjectFacts.fromProjectVersionText('m_EditorVersion: 2022.3.53f1\n'),
    );

    for (const [needle, source] of [
      ['Cull Back', 'SL-Cull.html'],
      ['HDR', 'SL-Properties.html'],
      ['2D)', 'SL-Properties.html'],
      ['SV_Target', 'SL-ShaderSemantics.html'],
    ] as const) {
      const hover = await revision.hoverAt({
        document,
        position: positionOf(text, needle, 0, needle === 'Cull Back' ? 1 : 0),
      });
      const value = (hover?.contents as { value?: string }).value ?? '';
      expect(value).toContain(source);
      expect(value).toContain('Curated fallback');
    }

    const unknown = await revision.hoverAt({
      document,
      position: positionOf(text, '_Color', 0, 1),
    });
    expect(unknown).toBeNull();

    const unity6 = await publishOpenDocument(
      'file:///project',
      document,
      UnityProjectFacts.fromProjectVersionText('m_EditorVersion: 6000.0.42f1\n'),
    );
    const unity6Hover = await unity6.hoverAt({
      document,
      position: positionOf(text, 'Cull Back', 0, 1),
    });
    expect((unity6Hover?.contents as { value?: string }).value).toContain(
      'verified against Unity 2022.3',
    );

    const standalone = await publishOpenDocument('file:///project', document);
    const standaloneHover = await standalone.hoverAt({
      document,
      position: positionOf(text, 'SV_Target', 0, 1),
    });
    expect((standaloneHover?.contents as { value?: string }).value).toContain(
      'editor version is unknown',
    );
    const retained = await revision.hoverAt({
      document,
      position: positionOf(text, 'Cull Back', 0, 1),
    });
    expect((retained?.contents as { value?: string }).value).toContain('SL-Cull.html');
  });

  it('keeps a project declaration authoritative over a same-name curated helper', async () => {
    const uri = 'file:///project/Assets/ProjectHelper.hlsl';
    const text = [
      'float4 GetVertexPositionInputs(float3 custom) { return 1; }',
      'float4 Main() { return GetVertexPositionInputs(0); }',
    ].join('\n');
    const revision = await publishTextFiles('file:///project', [{ uri, text }]);
    const document = snapshot(uri, text);
    const hover = await revision.hoverAt({
      document,
      position: positionOf(text, 'GetVertexPositionInputs', 1, 1),
    });
    const value = (hover?.contents as { value?: string }).value ?? '';

    expect(value).toContain('float4 GetVertexPositionInputs(float3 custom)');
    expect(value).not.toContain('Curated fallback');
  });

  it('keeps Package fallback bound to captured include visibility and Package facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-package-fallback-hover-'));
    const packageName = 'com.unity.render-pipelines.universal';
    const packageRoot = join(root, 'Library', 'PackageCache', `${packageName}@hash`);
    const mainPath = join(root, 'Assets', 'Main.hlsl');
    const helperPath = join(packageRoot, 'ShaderLibrary', 'Core.hlsl');
    const withInclude = [
      `#include "Packages/${packageName}/ShaderLibrary/Core.hlsl"`,
      'float4 Main() { return GetVertexPositionInputs(0).positionCS; }',
    ].join('\n');
    const withoutInclude = 'float4 Main() { return GetVertexPositionInputs(0).positionCS; }';
    await Promise.all([
      mkdir(join(root, 'Packages'), { recursive: true }),
      mkdir(join(root, 'Assets'), { recursive: true }),
      mkdir(join(packageRoot, 'ShaderLibrary'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
        dependencies: {
          [packageName]: { version: '17.0.3', source: 'registry', hash: 'hash' },
        },
      })),
      writeFile(join(root, 'Packages', 'manifest.json'), JSON.stringify({
        dependencies: { [packageName]: '17.0.3' },
        scopedRegistries: [],
      })),
      writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        version: '17.0.3',
      })),
      writeFile(mainPath, withInclude),
      writeFile(helperPath, '// Visible package source without an indexed declaration.'),
    ]);

    try {
      const packages = await PackageContext.load(root, DEFAULT_SETTINGS);
      const mainUri = pathToFileURL(mainPath).href;
      const [withIncludeIndex, withoutIncludeIndex] = await Promise.all([
        indexFile(mainUri, withInclude),
        indexFile(mainUri, withoutInclude),
      ]);
      const first = publishIndexes(pathToFileURL(root).href, [withIncludeIndex], {
        unityRoot: root,
        packages,
      });
      const nextBuilder = first.fork();
      nextBuilder.restoreFromCache(mainUri, withoutIncludeIndex);
      const second = nextBuilder.publish(2);
      const firstDocument = snapshot(mainUri, withInclude);
      const secondDocument = snapshot(mainUri, withoutInclude);

      const firstHover = await first.hoverAt({
        document: firstDocument,
        position: positionOf(withInclude, 'GetVertexPositionInputs', 0, 1),
      });
      const firstValue = (firstHover?.contents as { value?: string }).value ?? '';
      expect(firstValue).toContain('Curated fallback');
      expect(firstValue).toContain(`${packageName}@17.0.3`);
      expect(firstValue).toContain('registry');

      await expect(second.hoverAt({
        document: secondDocument,
        position: positionOf(withoutInclude, 'GetVertexPositionInputs', 0, 1),
      })).resolves.toBeNull();

      await Promise.all([
        writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
          dependencies: {
            [packageName]: { version: '16.0.6', source: 'registry', hash: 'hash' },
          },
        })),
        writeFile(join(packageRoot, 'package.json'), JSON.stringify({
          name: packageName,
          version: '16.0.6',
        })),
      ]);
      const incompatiblePackages = await PackageContext.load(root, DEFAULT_SETTINGS);
      const incompatible = publishIndexes(pathToFileURL(root).href, [withIncludeIndex], {
        unityRoot: root,
        packages: incompatiblePackages,
      });
      await expect(incompatible.hoverAt({
        document: firstDocument,
        position: positionOf(withInclude, 'GetVertexPositionInputs', 0, 1),
      })).resolves.toBeNull();

      const retained = await first.hoverAt({
        document: firstDocument,
        position: positionOf(withInclude, 'GetVertexPositionInputs', 0, 1),
      });
      const retainedValue = (retained?.contents as { value?: string }).value ?? '';
      expect(retainedValue).toContain('Curated fallback');
      expect(retainedValue).toContain(`${packageName}@17.0.3`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shows exact Package provenance when a visible HDRP declaration wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-package-hover-'));
    const packageName = 'com.unity.render-pipelines.high-definition';
    const packageRoot = join(root, 'Library', 'PackageCache', `${packageName}@hash`);
    const mainPath = join(root, 'Assets', 'Main.hlsl');
    const helperPath = join(packageRoot, 'ShaderLibrary', 'Exposure.hlsl');
    const mainText = [
      `#include "Packages/${packageName}/ShaderLibrary/Exposure.hlsl"`,
      'float Main() { return GetCurrentExposureMultiplier(); }',
    ].join('\n');
    const helperText = 'float GetCurrentExposureMultiplier() { return 1; }';
    await Promise.all([
      mkdir(join(root, 'Packages'), { recursive: true }),
      mkdir(join(root, 'Assets'), { recursive: true }),
      mkdir(join(packageRoot, 'ShaderLibrary'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
        dependencies: {
          [packageName]: { version: '17.0.3', source: 'registry', hash: 'hash' },
        },
      })),
      writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        version: '17.0.3',
      })),
      writeFile(mainPath, mainText),
      writeFile(helperPath, helperText),
    ]);

    try {
      const packages = await PackageContext.load(root, DEFAULT_SETTINGS);
      const mainUri = pathToFileURL(mainPath).href;
      const helperUri = pathToFileURL(helperPath).href;
      const [mainIndex, helperIndex] = await Promise.all([
        indexFile(mainUri, mainText),
        indexFile(helperUri, helperText),
      ]);
      const revision = publishIndexes(pathToFileURL(root).href, [mainIndex, helperIndex], {
        unityRoot: root,
        packages,
      });
      const document = snapshot(mainUri, mainText);
      const hover = await revision.hoverAt({
        document,
        position: positionOf(mainText, 'GetCurrentExposureMultiplier', 0, 1),
      });
      const value = (hover?.contents as { value?: string }).value ?? '';

      expect(value).toContain('float GetCurrentExposureMultiplier()');
      expect(value).toContain('com.unity.render-pipelines.high-definition@17.0.3');
      expect(value).toContain('registry');
      expect(value).not.toContain('Curated fallback');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares nearest scoped selection across definition, hover, and completion', async () => {
    const uri = 'file:///project/Assets/Selection.hlsl';
    const text = ['// 0', '// 1', '// 2', '// 3', 'value;', 'receiver.'].join('\n');
    const scopeRange = {
      start: { line: 0, character: 0 },
      end: { line: 10, character: 0 },
    };
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [
        symbol('value', 'variable', uri, 0, { declaredType: 'float4' }),
        symbol('value', 'parameter', uri, 0, { declaredType: 'half', scopeRange }),
        symbol('value', 'localVariable', uri, 1, { declaredType: 'float2', scopeRange }),
        symbol('value', 'localVariable', uri, 3, { declaredType: 'float3', scopeRange }),
        symbol('receiver', 'parameter', uri, 0, { declaredType: 'Far', scopeRange }),
        symbol('receiver', 'localVariable', uri, 3, { declaredType: 'Near', scopeRange }),
        symbol('nearOnly', 'structMember', uri, 0, { parentType: 'Near' }),
        symbol('farOnly', 'structMember', uri, 0, { parentType: 'Far' }),
      ],
    };
    const revision = publishIndexes('file:///project', [index]);
    const document = snapshot(uri, text);

    const definition = await revision.definitionAt({
      document,
      position: { line: 4, character: 1 },
    });
    expect(definition).toHaveLength(1);
    expect((definition?.[0] as { targetRange: { start: { line: number } } })
      .targetRange.start.line).toBe(3);

    const hover = await revision.hoverAt({
      document,
      position: { line: 4, character: 1 },
    });
    expect((hover?.contents as { value?: string }).value).toContain('float3 value');

    const completions = await revision.completionAt({
      document,
      position: { line: 4, character: 3 },
    });
    const valueCompletions = completions?.filter((item) => item.label === 'value') ?? [];
    expect(valueCompletions).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: 'float3 value' }),
      expect.objectContaining({ detail: 'float4 value' }),
    ]));
    expect(valueCompletions.filter((item) => item.detail === 'float3 value')).toHaveLength(1);

    const members = await revision.completionAt({
      document,
      position: { line: 5, character: 'receiver.'.length },
    });
    expect(members?.map((item) => item.label)).toEqual(['nearOnly']);
  });

  it('preserves include visibility, formatting, signatures, completion, and scoped highlights', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-query-behavior-'));
    const mainPath = join(root, 'Main.hlsl');
    const sharedPath = join(root, 'Shared.hlsl');
    const otherPath = join(root, 'Other.hlsl');
    const mainText = [
      '#include "Shared.hlsl"',
      'struct Surface { float3 positionWS; };',
      'float4 Main(Surface surface) {',
      '  float localValue = 0;',
      '  localValue = localValue + 1;',
      '  float4 lit = Lighting(surface.positionWS, 0.5);',
      '  return Included();',
      '}',
    ].join('\n');
    const sharedText = [
      'float4 Included() { return 1; }',
      'float4 Lighting(float3 normalWS, half roughness) { return 1; }',
      'float4 Lighting(half3 normalWS, half roughness) { return 1; }',
    ].join('\n');
    const otherText = [
      'float4 HiddenOnly() { return 0; }',
      'float4 Lighting(float4 hidden, half roughness) { return hidden; }',
    ].join('\n');
    await Promise.all([
      writeFile(mainPath, mainText),
      writeFile(sharedPath, sharedText),
      writeFile(otherPath, otherText),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const sharedUri = pathToFileURL(sharedPath).href;
      const otherUri = pathToFileURL(otherPath).href;
      const revision = await publishTextFiles(pathToFileURL(root).href, [
        { uri: mainUri, text: mainText },
        { uri: sharedUri, text: sharedText },
        { uri: otherUri, text: otherText },
      ]);
      const document = snapshot(mainUri, mainText);

      const hover = await revision.hoverAt({
        document,
        position: positionOf(mainText, 'Included();', 0, 1),
      });
      const hoverValue = (hover?.contents as { value?: string }).value ?? '';
      expect(hoverValue).toContain('float4 Included()');
      expect(hoverValue).toContain('Shared.hlsl');
      expect(hoverValue).not.toContain('Other.hlsl');

      const completions = await revision.completionAt({
        document,
        position: positionOf(mainText, 'Included();'),
      });
      const completionNames = completions?.map((item) => item.label) ?? [];
      expect(completionNames).toContain('Included');
      expect(completionNames).toContain('Lighting');
      expect(completionNames).not.toContain('HiddenOnly');

      const signatureHelp = await revision.signatureHelpAt({
        document,
        position: positionOf(mainText, '0.5'),
      });
      expect(signatureHelp?.activeParameter).toBe(1);
      expect(signatureHelp?.signatures.map((signature) => signature.label)).toEqual([
        'float4 Lighting(float3 normalWS, half roughness)',
        'float4 Lighting(half3 normalWS, half roughness)',
      ]);

      const highlights = await revision.highlightsAt({
        document,
        position: positionOf(mainText, 'localValue', 1, 1),
      });
      expect(highlights?.map((highlight) => ({
        line: highlight.range.start.line,
        kind: highlight.kind,
      }))).toEqual([
        { line: 3, kind: DocumentHighlightKind.Text },
        { line: 4, kind: DocumentHighlightKind.Text },
        { line: 4, kind: DocumentHighlightKind.Text },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Definition and Hover bound to the Include chain of their captured revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-revision-include-chain-'));
    const mainPath = join(root, 'Main.hlsl');
    const oldPath = join(root, 'Old.hlsl');
    const nextPath = join(root, 'Next.hlsl');
    const oldMainText = [
      '#include "Old.hlsl"',
      'float4 Main() { return Target(); }',
    ].join('\n');
    const nextMainText = [
      '#include "Next.hlsl"',
      'float4 Main() { return Target(); }',
    ].join('\n');
    const oldText = 'float4 Target() { return 1; }';
    const nextText = 'float4 Target() { return 2; }';
    await Promise.all([
      writeFile(mainPath, nextMainText),
      writeFile(oldPath, oldText),
      writeFile(nextPath, nextText),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const oldUri = pathToFileURL(oldPath).href;
      const nextUri = pathToFileURL(nextPath).href;
      const [oldMainIndex, nextMainIndex, oldIndex, nextIndex] = await Promise.all([
        indexFile(mainUri, oldMainText),
        indexFile(mainUri, nextMainText),
        indexFile(oldUri, oldText),
        indexFile(nextUri, nextText),
      ]);
      const first = publishIndexes(pathToFileURL(root).href, [
        oldMainIndex,
        oldIndex,
        nextIndex,
      ]);
      const nextBuilder = first.fork();
      nextBuilder.restoreFromCache(mainUri, nextMainIndex);
      const second = nextBuilder.publish(2);

      const firstDocument = snapshot(mainUri, oldMainText);
      const secondDocument = snapshot(mainUri, nextMainText);
      const firstDefinition = await first.definitionAt({
        document: firstDocument,
        position: positionOf(oldMainText, 'Target();', 0, 1),
      });
      const secondDefinition = await second.definitionAt({
        document: secondDocument,
        position: positionOf(nextMainText, 'Target();', 0, 1),
      });
      expect(firstDefinition?.[0]).toMatchObject({ targetUri: oldUri });
      expect(secondDefinition?.[0]).toMatchObject({ targetUri: nextUri });

      const firstHover = await first.hoverAt({
        document: firstDocument,
        position: positionOf(oldMainText, 'Target();', 0, 1),
      });
      const secondHover = await second.hoverAt({
        document: secondDocument,
        position: positionOf(nextMainText, 'Target();', 0, 1),
      });
      expect((firstHover?.contents as { value?: string }).value).toContain('Old.hlsl');
      expect((firstHover?.contents as { value?: string }).value).not.toContain('Next.hlsl');
      expect((secondHover?.contents as { value?: string }).value).toContain('Next.hlsl');
      expect((secondHover?.contents as { value?: string }).value).not.toContain('Old.hlsl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds Include chain search roots from the captured revision settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-revision-include-settings-'));
    const sourceRoot = join(root, 'Source');
    const includeRoot = join(root, 'ConfiguredIncludes');
    const mainPath = join(sourceRoot, 'Main.hlsl');
    const sharedPath = join(includeRoot, 'Shared.hlsl');
    const mainText = [
      '#include "Shared.hlsl"',
      'float4 Main() { return ConfiguredTarget(); }',
    ].join('\n');
    const sharedText = 'float4 ConfiguredTarget() { return 1; }';
    await Promise.all([
      mkdir(sourceRoot, { recursive: true }),
      mkdir(includeRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(mainPath, mainText),
      writeFile(sharedPath, sharedText),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const sharedUri = pathToFileURL(sharedPath).href;
      const settings = {
        ...DEFAULT_SETTINGS,
        includeDirectories: [includeRoot],
      };
      const revision = publishIndexes(
        pathToFileURL(root).href,
        await Promise.all([
          indexFile(mainUri, mainText),
          indexFile(sharedUri, sharedText),
        ]),
        {
          settings,
          // Deliberately excludes the configured directory: revision settings
          // own search roots while PackageContext owns package mappings.
          packages: PackageContext.standalone(DEFAULT_SETTINGS),
        },
      );

      const definition = await revision.definitionAt({
        document: snapshot(mainUri, mainText),
        position: positionOf(mainText, 'ConfiguredTarget();', 0, 1),
      });
      expect(definition?.[0]).toMatchObject({ targetUri: sharedUri });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('selects member candidates and the first arity-compatible overload through a published revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-query-candidates-'));
    const mainPath = join(root, 'Main.hlsl');
    const sharedPath = join(root, 'Shared.hlsl');
    const hiddenPath = join(root, 'Hidden.hlsl');
    const mainText = [
      '#include "Shared.hlsl"',
      'float4 Mixed(float value) { return value; }',
      'float4 Use(Surface surface) {',
      '  float4 result = Mixed(1, 2);',
      '  return float4(surface.po, 1);',
      '}',
    ].join('\n');
    const sharedText = [
      'struct Surface { float3 positionWS; float2 uv; };',
      'float4 Mixed(float first, float second) { return first + second; }',
    ].join('\n');
    const hiddenText = 'struct Surface { float3 hiddenOnly; };';
    await Promise.all([
      writeFile(mainPath, mainText),
      writeFile(sharedPath, sharedText),
      writeFile(hiddenPath, hiddenText),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const revision = await publishTextFiles(pathToFileURL(root).href, [
        { uri: mainUri, text: mainText },
        { uri: pathToFileURL(sharedPath).href, text: sharedText },
        { uri: pathToFileURL(hiddenPath).href, text: hiddenText },
      ]);
      const document = snapshot(mainUri, mainText);

      const members = await revision.completionAt({
        document,
        position: positionOf(mainText, 'surface.po', 0, 'surface.po'.length),
      });
      expect(members?.map((item) => item.label)).toEqual(['positionWS']);

      const signatureHelp = await revision.signatureHelpAt({
        document,
        position: positionOf(mainText, '2);'),
      });
      expect(signatureHelp?.signatures.map((signature) => signature.label)).toEqual([
        'float4 Mixed(float value)',
        'float4 Mixed(float first, float second)',
      ]);
      expect(signatureHelp?.activeSignature).toBe(1);
      expect(signatureHelp?.activeParameter).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('provides multiline member signatures from include-visible struct methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-member-signatures-'));
    const mainPath = join(root, 'Main.hlsl');
    const sharedPath = join(root, 'Shared.hlsl');
    const hiddenPath = join(root, 'Hidden.hlsl');
    const mainText = [
      '#include "Shared.hlsl"',
      'float4 Use(Surface surface) {',
      '  return surface.Shade(',
      '    1,',
      '    2',
      '  );',
      '}',
      'float4 Again(Surface surface) { return surface.Shade(3); }',
    ].join('\n');
    const sharedText = [
      'struct Surface {',
      '  float4 Shade(float x);',
      '  float4 Shade(float x, float y);',
      '};',
      'float4 Surface::Shade(float x) { return x; }',
      'float4 Surface::Shade(float x, float y) { return x + y; }',
    ].join('\n');
    const hiddenText = [
      'struct Surface { float4 Shade(float x, float y, float z); };',
      'float4 Surface::Shade(float x, float y, float z) { return x + y + z; }',
    ].join('\n');
    await Promise.all([
      writeFile(mainPath, mainText),
      writeFile(sharedPath, sharedText),
      writeFile(hiddenPath, hiddenText),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const revision = await publishTextFiles(pathToFileURL(root).href, [
        { uri: mainUri, text: mainText },
        { uri: pathToFileURL(sharedPath).href, text: sharedText },
        { uri: pathToFileURL(hiddenPath).href, text: hiddenText },
      ]);

      const signatureHelp = await revision.signatureHelpAt({
        document: snapshot(mainUri, mainText),
        position: positionOf(mainText, '    2', 0, 5),
      });

      expect(signatureHelp?.signatures.map((signature) => signature.label)).toEqual([
        'float4 Shade(float x)',
        'float4 Shade(float x, float y)',
      ]);
      expect(signatureHelp?.activeSignature).toBe(1);
      expect(signatureHelp?.activeParameter).toBe(1);
      expect(revision.workspaceSymbols('Shade')[0]).toMatchObject({
        name: 'Shade',
        containerName: 'Surface',
      });
      const memberPosition = positionOf(mainText, 'surface.Shade', 0, 'surface.'.length);
      const definitions = await revision.definitionAt({
        document: snapshot(mainUri, mainText),
        position: memberPosition,
      });
      expect(definitions).toHaveLength(4);
      expect(definitions?.every((location) => (
        'targetUri' in location
          ? location.targetUri === pathToFileURL(sharedPath).href
          : location.uri === pathToFileURL(sharedPath).href
      ))).toBe(true);

      const references = await revision.referencesAt({
        document: snapshot(mainUri, mainText),
        position: memberPosition,
        includeDeclaration: true,
      });
      expect(references).toHaveLength(6);
      expect(references?.some((location) => location.uri === pathToFileURL(hiddenPath).href))
        .toBe(false);

      const highlights = await revision.highlightsAt({
        document: snapshot(mainUri, mainText),
        position: memberPosition,
      });
      expect(highlights?.map((highlight) => highlight.range.start.line)).toEqual([2, 7]);

      const hover = await revision.hoverAt({
        document: snapshot(mainUri, mainText),
        position: memberPosition,
      });
      expect((hover?.contents as { value?: string }).value).toContain('_member of_ `Surface`');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes generic texture member completion and multiline overload signatures', async () => {
    const uri = 'file:///project/Assets/TextureMembers.hlsl';
    const text = [
      'float4 Use(Texture2D<float4> texture, SamplerState samplerState) {',
      '  texture.Sam',
      '  return texture.Sample(',
      '    samplerState,',
      '    float2(0, 0),',
      '    int2(0, 0)',
      '  );',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const revision = await publishOpenDocument('file:///project', document);

    const completion = await revision.completionAt({
      document,
      position: positionOf(text, 'texture.Sam', 0, 'texture.Sam'.length),
    });
    expect(completion?.filter((item) => item.label === 'Sample')).toHaveLength(1);

    const signatureHelp = await revision.signatureHelpAt({
      document,
      position: positionOf(text, '    int2(0, 0)', 0, '    int2(0, 0)'.length),
    });
    expect(signatureHelp?.signatures.map((signature) => signature.label)).toEqual([
      'T Sample(SamplerState samplerState, float2 location)',
      'T Sample(SamplerState samplerState, float2 location, int2 offset)',
    ]);
    expect(signatureHelp?.activeSignature).toBe(1);
    expect(signatureHelp?.activeParameter).toBe(2);
  });

  it('publishes typed texture macro members without guessing TEXTURE2D_X ownership', async () => {
    const uri = 'file:///project/Assets/TextureMacros.hlsl';
    const text = [
      'TYPED_TEXTURE2D(float4, _TypedTexture);',
      'TEXTURE2D_X(_PlatformTexture);',
      'SAMPLER(sampler_TypedTexture);',
      'float4 Use() {',
      '  _TypedTexture.Sam',
      '  _PlatformTexture.Sam',
      '  return _TypedTexture.Sample(',
      '    sampler_TypedTexture,',
      '    float2(0, 0)',
      '  );',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const revision = await publishOpenDocument('file:///project', document);

    const typedMembers = await revision.completionAt({
      document,
      position: positionOf(text, '_TypedTexture.Sam', 0, '_TypedTexture.Sam'.length),
    });
    expect(typedMembers?.filter((item) => item.label === 'Sample')).toHaveLength(1);

    const platformMembers = await revision.completionAt({
      document,
      position: positionOf(text, '_PlatformTexture.Sam', 0, '_PlatformTexture.Sam'.length),
    });
    expect(platformMembers?.map((item) => item.label)).not.toContain('Sample');

    const signatureHelp = await revision.signatureHelpAt({
      document,
      position: positionOf(text, '    float2(0, 0)', 0, '    float2(0, 0)'.length),
    });
    expect(signatureHelp?.signatures.map((signature) => signature.label)).toEqual([
      'T Sample(SamplerState samplerState, float2 location)',
      'T Sample(SamplerState samplerState, float2 location, int2 offset)',
    ]);
    expect(signatureHelp?.activeSignature).toBe(0);
    expect(signatureHelp?.activeParameter).toBe(1);
  });

  it('publishes vector swizzles and bounded non-square matrix members', async () => {
    const uri = 'file:///project/Assets/NumericMembers.hlsl';
    const text = [
      'float Use(float4 color, float3x4 transform) {',
      '  float2 pair = color.xy;',
      '  return transform._m2;',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const revision = await publishOpenDocument('file:///project', document);

    const swizzles = await revision.completionAt({
      document,
      position: positionOf(text, 'color.xy', 0, 'color.xy'.length),
    });
    expect(swizzles).toContainEqual(expect.objectContaining({
      label: 'xy',
      detail: 'HLSL vector swizzle',
    }));

    const matrixMembers = await revision.completionAt({
      document,
      position: positionOf(text, 'transform._m2', 0, 'transform._m2'.length),
    });
    expect(matrixMembers).toContainEqual(expect.objectContaining({
      label: '_m23',
      detail: 'HLSL matrix component',
    }));
    expect(matrixMembers?.map((item) => item.label)).not.toContain('_m30');
  });

  it('reuses published HLSL lexical facts for a high-line multiline call', async () => {
    const uri = 'file:///project/HighLine.hlsl';
    const text = [
      'float Lighting(float x, float y) { return x + y; }',
      ...Array.from({ length: 300 }, (_, index) => `float filler${index};`),
      'float Use() {',
      '  return Lighting(',
      '    1,',
      '    2',
      '  );',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const position = positionOf(text, '    2', 0, 5);
    const revision = await publishOpenDocument('file:///project', document);
    const facts = createCursorRequestFacts(
      document,
      position,
      revision.requestSource(document),
    );

    const signatureHelp = await revision.signatureHelpAt({ document, position }, facts);

    expect(signatureHelp?.signatures.map((signature) => signature.label)).toEqual([
      'float Lighting(float x, float y)',
    ]);
    expect(signatureHelp?.activeParameter).toBe(1);
  });

  it('keeps each published revision bound to its own suggestion selector', async () => {
    const uri = 'file:///project/Assets/Revision.hlsl';
    const first = publishIndexes('file:///project', [{
      uri,
      references: [],
      symbols: [symbol('FirstRevision', 'variable', uri, 0)],
    }]);
    const candidate = first.fork();
    candidate.restoreFromCache(uri, {
      uri,
      references: [],
      symbols: [symbol('SecondRevision', 'variable', uri, 0)],
    });
    const second = candidate.publish(2);
    const document = snapshot(uri, '');

    const firstNames = (await first.completionAt({
      document,
      position: { line: 0, character: 0 },
    }))?.map((item) => item.label);
    const secondNames = (await second.completionAt({
      document,
      position: { line: 0, character: 0 },
    }))?.map((item) => item.label);

    expect(firstNames).toContain('FirstRevision');
    expect(firstNames).not.toContain('SecondRevision');
    expect(secondNames).toContain('SecondRevision');
    expect(secondNames).not.toContain('FirstRevision');
  });

  it('preserves HLSL semantic tokens, including macros resolved from another index', async () => {
    const uri = 'file:///project/Assets/Semantic.hlsl';
    const includeUri = 'file:///project/Assets/Includes/Macros.hlsl';
    const text = [
      '#define SAMPLE_TEXTURE2D(tex, sampler, uv) tex.Sample(sampler, uv)',
      'struct InputData { float3 positionWS; };',
      'float4 Helper(InputData inputData) {',
      '  inputData = (InputData)0;',
      '  inputData.positionWS = 0;',
      '  return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, inputData.positionWS);',
      '  return INCLUDED_MACRO(inputData.positionWS);',
      '}',
      'float4 LocalExample() {',
      '  InputData inputData;',
      '  return float4(inputData.positionWS, 1);',
      '}',
    ].join('\n');
    const includeText = '#define INCLUDED_MACRO(v) v';
    const revision = await publishTextFiles('file:///project', [
      { uri, text },
      { uri: includeUri, text: includeText },
    ]);

    const tokens = decodeTokens(await revision.semanticTokens({
      uri,
      document: snapshot(uri, text),
    }));
    const cancellation = new CancellationTokenSource();
    const cancellableTokens = decodeTokens(await revision.semanticTokens({
      uri,
      document: snapshot(uri, text),
      cancellation: cancellation.token,
    }));
    cancellation.dispose();

    expectSortedAndNonOverlapping(tokens);
    expect(cancellableTokens).toEqual(tokens);
    expect(tokens).toEqual(expect.arrayContaining([
      { line: 0, character: 8, length: 'SAMPLE_TEXTURE2D'.length, type: 'macro' },
      { line: 1, character: 7, length: 'InputData'.length, type: 'type' },
      { line: 1, character: 26, length: 'positionWS'.length, type: 'property' },
      { line: 2, character: 7, length: 'Helper'.length, type: 'function' },
      { line: 2, character: 14, length: 'InputData'.length, type: 'type' },
      { line: 2, character: 24, length: 'inputData'.length, type: 'parameter' },
      { line: 3, character: 15, length: 'InputData'.length, type: 'type' },
      { line: 4, character: 12, length: 'positionWS'.length, type: 'property' },
      { line: 5, character: 9, length: 'SAMPLE_TEXTURE2D'.length, type: 'macro' },
      { line: 6, character: 9, length: 'INCLUDED_MACRO'.length, type: 'macro' },
      { line: 9, character: 2, length: 'InputData'.length, type: 'type' },
      { line: 9, character: 12, length: 'inputData'.length, type: 'variable' },
      { line: 10, character: 26, length: 'positionWS'.length, type: 'property' },
    ]));
  });

  it('observes in-flight cancellation during a large semantic token scan', async () => {
    const uri = 'file:///project/Assets/LongSemanticTokens.hlsl';
    let scanned = 0;
    const symbols = Array.from({ length: 4096 }, (_, index) => {
      const entry = symbol(`Value${index}`, 'variable', uri, index);
      Object.defineProperty(entry, 'kind', {
        enumerable: true,
        get() {
          scanned++;
          return 'variable';
        },
      });
      return entry;
    });
    const revision = publishIndexes('file:///project', [{ uri, references: [], symbols }]);
    scanned = 0;
    const cancellation = new CancellationTokenSource();
    const cancellationTask = setImmediate(() => cancellation.cancel());

    try {
      await expect(revision.semanticTokens({ uri, cancellation: cancellation.token }))
        .rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
      expect(scanned).toBeGreaterThan(0);
      expect(scanned).toBeLessThan(symbols.length);
    } finally {
      clearImmediate(cancellationTask);
      cancellation.dispose();
    }
  });

  it('preserves mixed ShaderLab lexical and indexed semantic tokens', async () => {
    const uri = 'file:///project/Assets/Mixed.shader';
    const text = [
      'Shader "Custom/Mixed" {',
      '  Properties {',
      '    [Header(Main)] [Space]',
      '    _BaseMap ("Base Map", 2D) = "white" {}',
      '    _LayerMap ("Layers", 2DArray) = "" {}',
      '    _ProbeMap ("Probes", CubeArray) = "" {}',
      '    _Tint ("Tint", Color) = (1, 0.5, 0, 1)',
      '    _Roughness ("Roughness", Range(0, 1)) = 0.5',
      '  }',
      '  SubShader {',
      '    Tags { "LightMode"="UniversalForward" "RenderType"="Opaque" }',
      '    LOD 100',
      '    UsePass "Hidden/SHADOWCASTER"',
      '    Pass {',
      '      Name "Forward"',
      '      Cull Back',
      '      ZWrite On',
      '      HLSLPROGRAM',
      '      #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
      '      #pragma vertex vert',
      '      #define SAMPLE_ALBEDO(tex, uv) tex.Sample(sampler##tex, uv)',
      '      TEXTURE2D(_BaseMap);',
      '      TEXTURE2D_HALF(_HalfMap);',
      '      SAMPLER(sampler_BaseMap);',
      '      Texture2D _DetailMap;',
      '      SamplerState sampler_DetailMap;',
      '      groupshared float SharedValue;',
      '      CBUFFER_START(UnityPerMaterial)',
      '      float4 _Tint;',
      '      CBUFFER_END',
      '      struct Attributes { float3 positionOS : POSITION; float2 uv : TEXCOORD0; };',
      '      bool finiteScreen() { return isnan(_ScreenParams.x) || isfinite(_ScreenParams.y); }',
      '      float4 vert(Attributes input) : SV_POSITION { return TransformObjectToHClip(input.positionOS).xyxy; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const revision = await publishOpenDocument('file:///project', document);

    const tokens = decodeTokens(await revision.semanticTokens({
      uri,
      document,
    }));
    const rendered = tokenTexts(text, tokens);

    expectSortedAndNonOverlapping(tokens);
    expect(rendered).toEqual(expect.arrayContaining([
      { text: 'Shader', type: 'keyword' },
      { text: 'Properties', type: 'keyword' },
      { text: 'Header', type: 'decorator' },
      { text: '_BaseMap', type: 'property' },
      { text: 'Base Map', type: 'string' },
      { text: '2D', type: 'type' },
      { text: '2DArray', type: 'type' },
      { text: 'CubeArray', type: 'type' },
      { text: 'Color', type: 'type' },
      { text: 'Range', type: 'type' },
      { text: 'LightMode', type: 'property' },
      { text: 'UniversalForward', type: 'string' },
      { text: 'LOD', type: 'keyword' },
      { text: 'UsePass', type: 'keyword' },
      { text: 'Cull', type: 'keyword' },
      { text: 'ZWrite', type: 'keyword' },
      { text: 'HLSLPROGRAM', type: 'keyword' },
      { text: '#include', type: 'keyword' },
      {
        text: 'Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl',
        type: 'string',
      },
      { text: '#pragma', type: 'keyword' },
      { text: 'vert', type: 'function' },
      { text: 'SAMPLE_ALBEDO', type: 'macro' },
      { text: 'TEXTURE2D', type: 'macro' },
      { text: 'TEXTURE2D_HALF', type: 'macro' },
      { text: 'SAMPLER', type: 'macro' },
      { text: 'Texture2D', type: 'type' },
      { text: 'SamplerState', type: 'type' },
      { text: 'groupshared', type: 'keyword' },
      { text: 'CBUFFER_START', type: 'macro' },
      { text: 'UnityPerMaterial', type: 'variable' },
      { text: 'Attributes', type: 'type' },
      { text: 'isnan', type: 'function' },
      { text: 'isfinite', type: 'function' },
      { text: '_ScreenParams', type: 'variable' },
      { text: 'POSITION', type: 'enumMember' },
      { text: 'TEXCOORD0', type: 'enumMember' },
      { text: 'SV_POSITION', type: 'enumMember' },
      { text: 'TransformObjectToHClip', type: 'function' },
      { text: 'positionOS', type: 'property' },
      { text: 'xyxy', type: 'property' },
      { text: 'ENDHLSL', type: 'keyword' },
    ]));
  });

  it('lets indexed HLSL symbols win ShaderLab keyword collisions', async () => {
    const uri = 'file:///project/Assets/KeywordCollision.shader';
    const text = [
      'Shader "Custom/KeywordCollision" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 Name(float4 Pass) : SV_Target {',
      '        return Pass;',
      '      }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const revision = await publishOpenDocument('file:///project', document);

    const tokens = decodeTokens(await revision.semanticTokens({
      uri,
      document,
    }));
    const rendered = tokenTexts(text, tokens);

    expect(rendered).toEqual(expect.arrayContaining([
      { text: 'Name', type: 'function' },
      { text: 'Pass', type: 'parameter' },
      { text: 'SV_Target', type: 'enumMember' },
    ]));
    expect(rendered).not.toContainEqual({ text: 'Name', type: 'keyword' });
    expect(tokens).not.toContainEqual({
      line: 4,
      character: 13,
      length: 'Name'.length,
      type: 'keyword',
    });
    expect(tokens).not.toContainEqual({
      line: 4,
      character: 26,
      length: 'Pass'.length,
      type: 'keyword',
    });
    expect(tokens).not.toContainEqual({
      line: 5,
      character: 15,
      length: 'Pass'.length,
      type: 'keyword',
    });
  });

  it('preserves Workspace Symbol filtering, containers, duplicates, and ordering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-query-symbols-'));
    const userPath = join(root, 'Assets', 'User.hlsl');
    const packageRoot = join(root, 'Packages', 'com.example.embedded');
    const packagePath = join(packageRoot, 'Package.hlsl');
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
      dependencies: {
        'com.example.embedded': {
          version: 'file:com.example.embedded',
          source: 'embedded',
        },
      },
    }));

    try {
      const userUri = pathToFileURL(userPath).href;
      const packageUri = pathToFileURL(packagePath).href;
      const indexes: FileIndex[] = [{
        uri: userUri,
        references: [],
        symbols: [
          symbol('Bravo', 'function', userUri, 0),
          symbol('Alpha', 'function', userUri, 10),
          symbol('Alpha', 'function', userUri, 2),
          symbol('color', 'structMember', userUri, 4, { parentType: 'Surface' }),
          symbol('HiddenAlpha', 'parameter', userUri, 5),
          symbol('LocalAlpha', 'localVariable', userUri, 6),
          symbol('   ', 'variable', userUri, 7),
        ],
      }, {
        uri: packageUri,
        references: [],
        symbols: [symbol('PackageAlpha', 'function', packageUri, 0)],
      }];
      const packages = await PackageContext.load(root, DEFAULT_SETTINGS);
      const revision = publishIndexes(pathToFileURL(root).href, indexes, {
        unityRoot: root,
        packages,
      });

      const ordered = revision.workspaceSymbols('a');
      const cancellation = new CancellationTokenSource();
      const cancellable = await revision.workspaceSymbols('a', cancellation.token);
      cancellation.dispose();
      expect(cancellable).toEqual(ordered);
      expect(ordered.map((entry) => (
        `${entry.name}@${entry.location.range.start.line}`
      ))).toEqual(['Alpha@2', 'Alpha@10', 'Bravo@0']);
      expect(ordered.filter((entry) => entry.name === 'Alpha')).toHaveLength(2);
      expect(revision.workspaceSymbols('HiddenAlpha')).toEqual([]);
      expect(revision.workspaceSymbols('LocalAlpha')).toEqual([]);
      expect(revision.workspaceSymbols('PackageAlpha')).toEqual([]);
      expect(revision.workspaceSymbols('   ')).toEqual([]);

      const member = revision.workspaceSymbols('color')[0];
      expect(member).toMatchObject({
        name: 'color',
        kind: LspSymbolKind.Field,
        containerName: 'Surface',
      });
      const functionSymbol = revision.workspaceSymbols('Bravo')[0];
      expect(functionSymbol).toMatchObject({
        kind: LspSymbolKind.Function,
        containerName: 'User.hlsl',
      });

      const includePackageSettings: ExtensionSettings = {
        ...DEFAULT_SETTINGS,
        findReferences: { includePackages: true },
      };
      const packageRevision = publishIndexes(pathToFileURL(root).href, indexes, {
        settings: includePackageSettings,
        unityRoot: root,
        packages,
      });
      expect(packageRevision.workspaceSymbols('PackageAlpha')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes in-flight cancellation during a large Workspace Symbol scan', async () => {
    const uri = 'file:///project/Assets/LongWorkspaceSymbols.hlsl';
    let scanned = 0;
    const symbols = Array.from({ length: 4096 }, (_, index) => {
      const name = `Needle${index.toString().padStart(4, '0')}`;
      const entry = symbol(name, 'function', uri, index);
      Object.defineProperty(entry, 'name', {
        enumerable: true,
        get() {
          scanned++;
          return name;
        },
      });
      return entry;
    });
    const revision = publishIndexes('file:///project', [{ uri, references: [], symbols }]);
    scanned = 0;
    const cancellation = new CancellationTokenSource();
    const cancellationTask = setImmediate(() => cancellation.cancel());

    try {
      await expect(revision.workspaceSymbols('Needle', cancellation.token))
        .rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
      expect(scanned).toBeGreaterThan(0);
      expect(scanned).toBeLessThan(symbols.length);
    } finally {
      clearImmediate(cancellationTask);
      cancellation.dispose();
    }
  });

  it('observes in-flight cancellation during a large ShaderLab Workspace Symbol scan', async () => {
    const uri = 'file:///project/Assets/LongShaderLabNames.shader';
    let scanned = 0;
    const shaders = Array.from({ length: 4096 }, (_, index) => {
      const name = `Shader/Needle${index.toString().padStart(4, '0')}`;
      const range = {
        start: { line: index, character: 8 },
        end: { line: index, character: 8 + name.length },
      };
      const entry = { name, nameRange: range, declarationRange: range };
      Object.defineProperty(entry, 'name', {
        enumerable: true,
        get() {
          scanned++;
          return name;
        },
      });
      return entry;
    });
    const revision = publishIndexes('file:///project', [{
      uri,
      references: [],
      symbols: [],
      shaderLabNames: { shaders, passes: [], references: [] },
    }]);
    scanned = 0;
    const cancellation = new CancellationTokenSource();
    const cancellationTask = setImmediate(() => cancellation.cancel());

    try {
      await expect(revision.workspaceSymbols('Needle', cancellation.token))
        .rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
      expect(scanned).toBeGreaterThan(0);
      expect(scanned).toBeLessThan(shaders.length);
    } finally {
      clearImmediate(cancellationTask);
      cancellation.dispose();
    }
  });

  it('globally sorts cross-root Workspace Symbols before applying the 1000-result cap', async () => {
    const roots = await Promise.all([
      createUnityProject('usn-query-cap-a-'),
      createUnityProject('usn-query-cap-b-'),
    ]);
    const manager = new WorkspaceManager();
    const names = Array.from(
      { length: 1002 },
      (_, index) => `Cap${index.toString().padStart(4, '0')}`,
    );
    const texts = [0, 1].map((parity) => names
      .filter((_, index) => index % 2 === parity)
      .map((name) => `float4 ${name}() { return 0; }`)
      .join('\n'));

    try {
      await Promise.all(roots.map((root, index) => (
        writeFile(join(root, 'Assets', 'Symbols.hlsl'), texts[index])
      )));
      for (const root of roots) {
        await manager.addFolder(pathToFileURL(root).href, DEFAULT_SETTINGS, connection);
      }

      const results = manager.workspaceSymbols('Cap');

      expect(results).toHaveLength(1000);
      expect(results.map((entry) => entry.name)).toEqual(names.slice(0, 1000));
    } finally {
      for (const root of roots) {
        await manager.removeFolder(pathToFileURL(root).href);
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

async function createUnityProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, 'Assets'), { recursive: true });
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
  return root;
}
