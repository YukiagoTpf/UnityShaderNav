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
  SymbolKind as LspSymbolKind,
  type SemanticTokens,
} from 'vscode-languageserver/node';
import { describe, expect, it } from 'vitest';
import { MacroPatternTable } from '../../src/macros';
import { PackageContext } from '../../src/packages';
import { indexFile } from '../../src/parser/hlsl';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import {
  IndexedRevisionBuilder,
  type PublishedIndexedRevision,
} from '../../src/workspace/indexedRevision';
import { SEMANTIC_TOKEN_TYPES } from '../../src/workspace/semanticTokenLegend';
import { WorkspaceManager } from '../../src/workspace/workspaceManager';

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
  const table = new MacroPatternTable(DEFAULT_SETTINGS.declarationMacros);
  const indexes = await Promise.all(
    files.map(({ uri, text }) => indexFile(uri, text, table)),
  );
  return publishIndexes(folderUri, indexes);
}

async function publishOpenDocument(
  folderUri: string,
  document: IndexedDocumentSnapshot,
): Promise<PublishedIndexedRevision> {
  const settings = DEFAULT_SETTINGS;
  const builder = IndexedRevisionBuilder.create({
    folderUri,
    settings,
    unityRoot: undefined,
    packages: PackageContext.standalone(settings),
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

    const tokens = decodeTokens(revision.semanticTokens({
      uri,
      document: snapshot(uri, text),
    }));

    expectSortedAndNonOverlapping(tokens);
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
      '      SAMPLER(sampler_BaseMap);',
      '      Texture2D _DetailMap;',
      '      SamplerState sampler_DetailMap;',
      '      CBUFFER_START(UnityPerMaterial)',
      '      float4 _Tint;',
      '      CBUFFER_END',
      '      struct Attributes { float3 positionOS : POSITION; float2 uv : TEXCOORD0; };',
      '      float4 vert(Attributes input) : SV_POSITION { return TransformObjectToHClip(input.positionOS).xyxy; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const document = snapshot(uri, text);
    const revision = await publishOpenDocument('file:///project', document);

    const tokens = decodeTokens(revision.semanticTokens({
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
      { text: 'SAMPLER', type: 'macro' },
      { text: 'Texture2D', type: 'type' },
      { text: 'SamplerState', type: 'type' },
      { text: 'CBUFFER_START', type: 'macro' },
      { text: 'UnityPerMaterial', type: 'variable' },
      { text: 'Attributes', type: 'type' },
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

    const tokens = decodeTokens(revision.semanticTokens({
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
