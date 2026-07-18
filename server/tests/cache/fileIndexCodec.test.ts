import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_VERSION,
  DEFAULT_SETTINGS,
  type CacheFingerprint,
  type FileIndex,
  type FunctionSymbolEntry,
} from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { MacroPatternRecognizer } from '../../src/macros';
import { PackageContext } from '../../src/packages';
import { indexFile } from '../../src/parser/hlsl';
import { CacheStore } from '../../src/cache/cacheStore';
import { decodePersistedFileIndex } from '../../src/cache/fileIndexCodec';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { IndexedRevisionBuilder } from '../../src/workspace/indexedRevision';
import { SRP_BATCHER_PROPERTY_CODE } from '../../src/workspace/materialContracts';

const fingerprint: CacheFingerprint = {
  indexImplementation: 'a'.repeat(64),
  grammarVersion: 'b'.repeat(64),
  settingsHash: 'settings',
  macroTableHash: 'macros',
};

const range = {
  start: { line: 1, character: 2 },
  end: { line: 1, character: 8 },
};

function completeIndex(uri = 'file:///project/Assets/Complete.shader'): FileIndex {
  const functionSymbol: FunctionSymbolEntry = {
    name: 'Shade',
    kind: 'function',
    location: { uri, range },
    scope: 'global',
    parentType: 'Surface',
    scopeRange: range,
    declaredType: 'float4',
    returnType: 'float4',
    parameters: [{ name: 'uv', type: 'float2', range }],
  };
  return {
    uri,
    symbols: [
      functionSymbol,
      {
        name: '_Color',
        kind: 'variable',
        location: { uri, range },
        declaredType: 'float4',
      },
    ],
    references: [{
      name: 'Shade',
      location: { uri, range },
      context: 'call',
      receiver: 'surface',
    }],
    typeInferences: [{
      receiver: 'surface',
      callName: 'MakeSurface',
      assignmentRange: range,
      scope: 'frag',
      scopeRange: range,
    }],
    structure: {
      shaders: [{
        kind: 'shader',
        name: 'Cache/Complete',
        headerLine: 0,
        closeLine: 20,
        children: [{
          kind: 'subshader',
          headerLine: 5,
          closeLine: 19,
          children: [{
            kind: 'pass',
            name: 'Forward',
            headerLine: 6,
            closeLine: 18,
            children: [],
          }],
        }],
      }],
    },
    properties: [
      { name: '_Color', nameRange: range, declarationRange: range, type: 'Color' },
      { name: '_Custom', nameRange: range, declarationRange: range, type: null },
    ],
    shaderLabNames: {
      shaders: [{
        name: 'Cache/Complete',
        nameRange: range,
        declarationRange: range,
      }],
      passes: [{
        shaderName: 'Cache/Complete',
        name: 'Forward',
        canonicalName: 'FORWARD',
        nameRange: range,
        declarationRange: range,
      }],
      references: [
        {
          kind: 'fallback',
          shaderName: 'Hidden/Fallback',
          shaderNameRange: range,
          directiveRange: range,
        },
        {
          kind: 'usePass',
          shaderName: 'Cache/Other',
          passName: 'FORWARD',
          canonicalPassName: 'FORWARD',
          shaderNameRange: range,
          passNameRange: range,
          directiveRange: range,
        },
      ],
    },
    shaderLabMaterial: {
      srpEvidence: true,
      subShaderCount: 1,
      hasIncludes: false,
      lineEnding: '\r\n',
      cbuffers: [{
        name: 'UnityPerMaterial',
        nameRange: range,
        declarationRange: range,
        fields: [{
          name: '_Color',
          type: 'float4',
          packOffset: 'c0',
          nameRange: range,
          declarationRange: range,
          conditional: false,
        }],
        blockIndex: 0,
        blockKind: 'HLSLPROGRAM',
        insertionPosition: range.start,
        fieldIndent: '    ',
        conditional: false,
        opaque: false,
        complete: true,
      }],
      programBlocks: [{
        blockIndex: 0,
        kind: 'HLSLPROGRAM',
        startLine: 7,
        endLine: 17,
        insertionPosition: range.start,
        indent: '  ',
        unterminated: false,
      }],
    },
  };
}

function positionOf(text: string, needle: string): { line: number; character: number } {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`Missing test token: ${needle}`);
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

describe('persisted FileIndex codec', () => {
  it('round-trips every current FileIndex field through CacheStore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-complete-file-index-'));
    const store = new CacheStore(dir);
    const index = completeIndex();

    try {
      await store.save({
        version: CACHE_VERSION,
        workspaceFolderUri: 'file:///project',
        unityProjectRoot: '/project',
        createdAt: 1,
        fingerprint,
        files: [{ uri: index.uri, mtimeMs: 1, size: 2, index }],
      });

      expect((await store.load(fingerprint))?.files[0]?.index).toEqual(index);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed values across every FileIndex projection', () => {
    const index = completeIndex();
    const functionSymbol = index.symbols[0] as FunctionSymbolEntry;
    const shader = index.structure!.shaders[0];
    const property = index.properties![0];
    const pass = index.shaderLabNames!.passes[0];
    const cbuffer = index.shaderLabMaterial!.cbuffers[0];

    const malformed: Array<{ label: string; value: unknown }> = [
      { label: 'owning uri', value: { ...index, uri: 'file:///foreign.shader' } },
      {
        label: 'function parameter range',
        value: {
          ...index,
          symbols: [{
            ...functionSymbol,
            parameters: [{
              ...functionSymbol.parameters[0],
              range: { start: { line: 'one', character: 0 }, end: range.end },
            }],
          }],
        },
      },
      {
        label: 'reference context',
        value: { ...index, references: [{ ...index.references[0], context: 'read' }] },
      },
      {
        label: 'type inference scope range',
        value: {
          ...index,
          typeInferences: [{ ...index.typeInferences![0], scopeRange: null }],
        },
      },
      {
        label: 'structure line',
        value: {
          ...index,
          structure: { shaders: [{ ...shader, headerLine: 'zero' }] },
        },
      },
      {
        label: 'property type',
        value: {
          ...index,
          properties: [{ ...property, type: 'Texture' }],
        },
      },
      {
        label: 'ShaderLab name range',
        value: {
          ...index,
          shaderLabNames: {
            ...index.shaderLabNames,
            passes: [{ ...pass, nameRange: { start: range.start } }],
          },
        },
      },
      {
        label: 'material block kind',
        value: {
          ...index,
          shaderLabMaterial: {
            ...index.shaderLabMaterial,
            cbuffers: [{ ...cbuffer, blockKind: 'PROGRAM' }],
          },
        },
      },
      { label: 'unknown active-schema field', value: { ...index, futureFacts: [] } },
    ];

    expect(decodePersistedFileIndex(index, index.uri)).toBe(index);
    for (const candidate of malformed) {
      expect(
        decodePersistedFileIndex(candidate.value, index.uri),
        candidate.label,
      ).toBeNull();
    }
  });

  it('serves cached Property facts after restore and publication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-property-publication-'));
    const store = new CacheStore(dir);
    const uri = 'file:///project/Assets/Material.shader';
    const text = [
      'Shader "Cache/Material" {',
      '  Properties {',
      '    _BaseColor ("Color", Color) = (1,1,1,1)',
      '    _Smoothness ("Smoothness", Range(0,1)) = 0.5',
      '  }',
      '  SubShader {',
      '    Tags { "RenderPipeline" = "UniversalPipeline" }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      CBUFFER_START(UnityPerMaterial)',
      '        float4 _BaseColor;',
      '      CBUFFER_END',
      '      float4 frag() : SV_Target { return _BaseColor; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const index = await indexFile(
      uri,
      text,
      new MacroPatternRecognizer(DEFAULT_SETTINGS.declarationMacros),
    );

    try {
      await store.save({
        version: CACHE_VERSION,
        workspaceFolderUri: 'file:///project',
        unityProjectRoot: '/project',
        createdAt: 1,
        fingerprint,
        files: [{ uri, mtimeMs: 1, size: text.length, index }],
      });
      const restored = (await store.load(fingerprint))?.files[0]?.index;
      if (!restored) throw new Error('Expected a restored FileIndex');

      const settings = DEFAULT_SETTINGS;
      const builder = IndexedRevisionBuilder.create({
        folderUri: 'file:///project',
        settings,
        unityRoot: undefined,
        packages: PackageContext.standalone(settings),
        cache: undefined,
        fingerprint: undefined,
      });
      builder.restoreFromCache(uri, restored);
      const revision = builder.publish(1);
      const document: IndexedDocumentSnapshot = {
        uri,
        text,
        languageId: 'shaderlab',
        openId: 1,
        version: 7,
      };
      const baseColor = restored.properties?.find((entry) => entry.name === '_BaseColor');
      const smoothness = restored.properties?.find((entry) => entry.name === '_Smoothness');
      if (!baseColor || !smoothness) throw new Error('Expected cached Property facts');

      await expect(revision.definitionAt({
        document,
        position: baseColor.nameRange.start,
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ targetUri: uri }),
      ]));

      const diagnostics = await revision.diagnostics(uri);
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: SRP_BATCHER_PROPERTY_CODE,
          range: smoothness.nameRange,
        }),
      ]));
      expect(revision.codeActions({
        document,
        range: smoothness.nameRange,
        context: { diagnostics },
      })).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Add _Smoothness to UnityPerMaterial' }),
      ]));
      expect(positionOf(text, '_BaseColor')).toEqual(baseColor.nameRange.start);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
