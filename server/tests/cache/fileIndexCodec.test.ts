import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_VERSION,
  DEFAULT_SETTINGS,
  type CacheFingerprint,
  type FileIndex,
  type FunctionParameter,
  type FunctionSymbolEntry,
  type Position,
  type Range,
  type ReferenceEntry,
  type ShaderContextDirectiveEntry,
  type ShaderContextSourceFacts,
  type ShaderContextStageEntry,
  type ShaderContextVariantPragmaEntry,
  type ShaderLabFallbackReference,
  type ShaderLabMaterialCbufferEntry,
  type ShaderLabMaterialFacts,
  type ShaderLabMaterialFieldEntry,
  type ShaderLabNameFacts,
  type ShaderLabPassNameEntry,
  type ShaderLabProgramBlockEntry,
  type ShaderLabPropertyEntry,
  type ShaderLabShaderNameEntry,
  type ShaderLabStructureNode,
  type ShaderLabUsePassReference,
  type ShaderProgramContextEntry,
  type StructureResult,
  type SymbolEntry,
  type TypeInferenceEntry,
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
import { createTestWorkspaceLocation } from '../helpers/testWorkspaceLocation';

const workspaceLocation = createTestWorkspaceLocation('usn-file-index-codec');

const fingerprint: CacheFingerprint = {
  releaseVersion: '0.1.1',
  grammarVersion: 'b'.repeat(64),
  settingsHash: 'settings',
  macroTableHash: 'macros',
};

const range = {
  start: { line: 1, character: 2 },
  end: { line: 1, character: 8 },
};

function completeIndex(
  uri = workspaceLocation.fileUri('Assets', 'Complete.shader'),
): FileIndex {
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
        children: [
          {
            kind: 'properties',
            headerLine: 1,
            closeLine: 4,
            children: [],
          },
          {
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
          },
        ],
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
    shaderContext: {
      directives: [{
        kind: 'include',
        name: 'Shared.hlsl',
        range,
        conditional: false,
        blockIndex: 0,
      }],
      variantPragmas: [{
        keywords: ['FEATURE_ON'],
        stage: 'fragment',
        conditional: false,
        blockIndex: 0,
      }],
      programs: [{
        blockIndex: 0,
        shaderName: 'Cache/Complete',
        subShaderIndex: 0,
        passIndex: 0,
        passName: 'Forward',
        stages: [{
          stage: 'fragment',
          entryPoint: 'Frag',
          defines: ['KERNEL_DEFINE'],
        }],
        sharedBlockIndices: [1],
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

type PathSegment = string | number;

interface FieldMutation {
  readonly path: readonly PathSegment[];
  readonly invalid: unknown;
}

type FieldMutations<T extends object> = {
  readonly [K in keyof T]-?: FieldMutation;
};

interface MalformedCase extends FieldMutation {
  readonly label: string;
}

function mutate(path: readonly PathSegment[], invalid: unknown): FieldMutation {
  return { path, invalid };
}

function fieldCases<T extends object>(
  scope: string,
  fields: FieldMutations<T>,
): MalformedCase[] {
  return (Object.entries(fields) as Array<[string, FieldMutation]>).map(
    ([field, mutation]) => ({ ...mutation, label: `${scope}.${field}` }),
  );
}

function malformedIndex(
  index: FileIndex,
  path: readonly PathSegment[],
  invalid: unknown,
): unknown {
  const clone: unknown = structuredClone(index);
  let parent = clone;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === 'number') {
      if (!Array.isArray(parent)) throw new Error(`Expected array before ${segment}`);
      parent = parent[segment];
    } else {
      if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) {
        throw new Error(`Expected record before ${segment}`);
      }
      parent = (parent as Record<string, unknown>)[segment];
    }
  }

  const field = path.at(-1);
  if (field === undefined) throw new Error('A malformed field path cannot be empty');
  if (typeof field === 'number') {
    if (!Array.isArray(parent)) throw new Error(`Expected array before ${field}`);
    parent[field] = invalid;
  } else {
    if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) {
      throw new Error(`Expected record before ${field}`);
    }
    (parent as Record<string, unknown>)[field] = invalid;
  }
  return clone;
}

type SymbolLocation = SymbolEntry['location'];
type FunctionSymbolSpecificFields = Pick<
  FunctionSymbolEntry,
  Exclude<keyof FunctionSymbolEntry, keyof SymbolEntry>
>;

describe('persisted FileIndex codec', () => {
  it('round-trips every current FileIndex field through CacheStore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-complete-file-index-'));
    const store = new CacheStore(dir);
    const index = completeIndex();

    try {
      await store.save({
        version: CACHE_VERSION,
        workspaceFolderUri: workspaceLocation.folderUri,
        unityProjectRoot: workspaceLocation.rootPath,
        createdAt: 1,
        fingerprint,
        files: [{ uri: index.uri, mtimeMs: 1, size: 2, index }],
      });

      expect((await store.load(fingerprint))?.files[0]?.index).toEqual(index);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed values for every persisted FileIndex field', () => {
    const index = completeIndex();
    const malformed: MalformedCase[] = [
      ...fieldCases<Position>('Position', {
        line: mutate(['symbols', 0, 'location', 'range', 'start', 'line'], 'one'),
        character: mutate(['symbols', 0, 'location', 'range', 'start', 'character'], false),
      }),
      ...fieldCases<Range>('Range', {
        start: mutate(['symbols', 0, 'location', 'range', 'start'], null),
        end: mutate(['symbols', 0, 'location', 'range', 'end'], null),
      }),
      ...fieldCases<SymbolLocation>('SymbolLocation', {
        uri: mutate(['symbols', 0, 'location', 'uri'], 'file:///foreign.shader'),
        range: mutate(['symbols', 0, 'location', 'range'], null),
      }),
      ...fieldCases<SymbolEntry>('SymbolEntry', {
        name: mutate(['symbols', 1, 'name'], 1),
        kind: mutate(['symbols', 1, 'kind'], 'futureSymbolKind'),
        location: mutate(['symbols', 1, 'location'], null),
        scope: mutate(['symbols', 1, 'scope'], 1),
        parentType: mutate(['symbols', 1, 'parentType'], 1),
        scopeRange: mutate(['symbols', 1, 'scopeRange'], null),
        declaredType: mutate(['symbols', 1, 'declaredType'], 1),
      }),
      ...fieldCases<FunctionSymbolSpecificFields>('FunctionSymbolEntry', {
        returnType: mutate(['symbols', 0, 'returnType'], 1),
        parameters: mutate(['symbols', 0, 'parameters'], null),
      }),
      ...fieldCases<FunctionParameter>('FunctionParameter', {
        name: mutate(['symbols', 0, 'parameters', 0, 'name'], 1),
        type: mutate(['symbols', 0, 'parameters', 0, 'type'], 1),
        range: mutate(['symbols', 0, 'parameters', 0, 'range'], null),
      }),
      ...fieldCases<ReferenceEntry>('ReferenceEntry', {
        name: mutate(['references', 0, 'name'], 1),
        location: mutate(['references', 0, 'location'], null),
        context: mutate(['references', 0, 'context'], 'read'),
        receiver: mutate(['references', 0, 'receiver'], 1),
      }),
      ...fieldCases<TypeInferenceEntry>('TypeInferenceEntry', {
        receiver: mutate(['typeInferences', 0, 'receiver'], 1),
        callName: mutate(['typeInferences', 0, 'callName'], 1),
        assignmentRange: mutate(['typeInferences', 0, 'assignmentRange'], null),
        scope: mutate(['typeInferences', 0, 'scope'], 1),
        scopeRange: mutate(['typeInferences', 0, 'scopeRange'], null),
      }),
      ...fieldCases<StructureResult>('StructureResult', {
        shaders: mutate(['structure', 'shaders'], null),
      }),
      ...fieldCases<ShaderLabStructureNode>('ShaderLabStructureNode', {
        kind: mutate(['structure', 'shaders', 0, 'kind'], 'program'),
        name: mutate(['structure', 'shaders', 0, 'name'], 1),
        headerLine: mutate(['structure', 'shaders', 0, 'headerLine'], 'zero'),
        closeLine: mutate(['structure', 'shaders', 0, 'closeLine'], 'twenty'),
        children: mutate(['structure', 'shaders', 0, 'children'], [null]),
      }),
      ...fieldCases<ShaderLabPropertyEntry>('ShaderLabPropertyEntry', {
        name: mutate(['properties', 0, 'name'], 1),
        nameRange: mutate(['properties', 0, 'nameRange'], null),
        declarationRange: mutate(['properties', 0, 'declarationRange'], null),
        type: mutate(['properties', 0, 'type'], 'Texture'),
      }),
      ...fieldCases<ShaderLabShaderNameEntry>('ShaderLabShaderNameEntry', {
        name: mutate(['shaderLabNames', 'shaders', 0, 'name'], 1),
        nameRange: mutate(['shaderLabNames', 'shaders', 0, 'nameRange'], null),
        declarationRange: mutate(
          ['shaderLabNames', 'shaders', 0, 'declarationRange'],
          null,
        ),
      }),
      ...fieldCases<ShaderLabPassNameEntry>('ShaderLabPassNameEntry', {
        shaderName: mutate(['shaderLabNames', 'passes', 0, 'shaderName'], 1),
        name: mutate(['shaderLabNames', 'passes', 0, 'name'], 1),
        canonicalName: mutate(['shaderLabNames', 'passes', 0, 'canonicalName'], 1),
        nameRange: mutate(['shaderLabNames', 'passes', 0, 'nameRange'], null),
        declarationRange: mutate(
          ['shaderLabNames', 'passes', 0, 'declarationRange'],
          null,
        ),
      }),
      ...fieldCases<ShaderLabFallbackReference>('ShaderLabFallbackReference', {
        kind: mutate(['shaderLabNames', 'references', 0, 'kind'], 'usePass'),
        shaderName: mutate(['shaderLabNames', 'references', 0, 'shaderName'], 1),
        shaderNameRange: mutate(
          ['shaderLabNames', 'references', 0, 'shaderNameRange'],
          null,
        ),
        directiveRange: mutate(
          ['shaderLabNames', 'references', 0, 'directiveRange'],
          null,
        ),
      }),
      ...fieldCases<ShaderLabUsePassReference>('ShaderLabUsePassReference', {
        kind: mutate(['shaderLabNames', 'references', 1, 'kind'], 'fallback'),
        shaderName: mutate(['shaderLabNames', 'references', 1, 'shaderName'], 1),
        passName: mutate(['shaderLabNames', 'references', 1, 'passName'], 1),
        canonicalPassName: mutate(
          ['shaderLabNames', 'references', 1, 'canonicalPassName'],
          1,
        ),
        shaderNameRange: mutate(
          ['shaderLabNames', 'references', 1, 'shaderNameRange'],
          null,
        ),
        passNameRange: mutate(
          ['shaderLabNames', 'references', 1, 'passNameRange'],
          null,
        ),
        directiveRange: mutate(
          ['shaderLabNames', 'references', 1, 'directiveRange'],
          null,
        ),
      }),
      ...fieldCases<ShaderLabNameFacts>('ShaderLabNameFacts', {
        shaders: mutate(['shaderLabNames', 'shaders'], null),
        passes: mutate(['shaderLabNames', 'passes'], null),
        references: mutate(['shaderLabNames', 'references'], null),
      }),
      ...fieldCases<ShaderLabMaterialFieldEntry>('ShaderLabMaterialFieldEntry', {
        name: mutate(['shaderLabMaterial', 'cbuffers', 0, 'fields', 0, 'name'], 1),
        type: mutate(['shaderLabMaterial', 'cbuffers', 0, 'fields', 0, 'type'], 1),
        packOffset: mutate(
          ['shaderLabMaterial', 'cbuffers', 0, 'fields', 0, 'packOffset'],
          1,
        ),
        nameRange: mutate(
          ['shaderLabMaterial', 'cbuffers', 0, 'fields', 0, 'nameRange'],
          null,
        ),
        declarationRange: mutate(
          ['shaderLabMaterial', 'cbuffers', 0, 'fields', 0, 'declarationRange'],
          null,
        ),
        conditional: mutate(
          ['shaderLabMaterial', 'cbuffers', 0, 'fields', 0, 'conditional'],
          'false',
        ),
      }),
      ...fieldCases<ShaderLabMaterialCbufferEntry>('ShaderLabMaterialCbufferEntry', {
        name: mutate(['shaderLabMaterial', 'cbuffers', 0, 'name'], 1),
        nameRange: mutate(['shaderLabMaterial', 'cbuffers', 0, 'nameRange'], null),
        declarationRange: mutate(
          ['shaderLabMaterial', 'cbuffers', 0, 'declarationRange'],
          null,
        ),
        fields: mutate(['shaderLabMaterial', 'cbuffers', 0, 'fields'], null),
        blockIndex: mutate(['shaderLabMaterial', 'cbuffers', 0, 'blockIndex'], 'zero'),
        blockKind: mutate(['shaderLabMaterial', 'cbuffers', 0, 'blockKind'], 'PROGRAM'),
        insertionPosition: mutate(
          ['shaderLabMaterial', 'cbuffers', 0, 'insertionPosition'],
          null,
        ),
        fieldIndent: mutate(['shaderLabMaterial', 'cbuffers', 0, 'fieldIndent'], 1),
        conditional: mutate(['shaderLabMaterial', 'cbuffers', 0, 'conditional'], 'false'),
        opaque: mutate(['shaderLabMaterial', 'cbuffers', 0, 'opaque'], 'false'),
        complete: mutate(['shaderLabMaterial', 'cbuffers', 0, 'complete'], 'true'),
      }),
      ...fieldCases<ShaderLabProgramBlockEntry>('ShaderLabProgramBlockEntry', {
        blockIndex: mutate(['shaderLabMaterial', 'programBlocks', 0, 'blockIndex'], 'zero'),
        kind: mutate(['shaderLabMaterial', 'programBlocks', 0, 'kind'], 'PROGRAM'),
        startLine: mutate(['shaderLabMaterial', 'programBlocks', 0, 'startLine'], 'seven'),
        endLine: mutate(['shaderLabMaterial', 'programBlocks', 0, 'endLine'], 'seventeen'),
        insertionPosition: mutate(
          ['shaderLabMaterial', 'programBlocks', 0, 'insertionPosition'],
          null,
        ),
        indent: mutate(['shaderLabMaterial', 'programBlocks', 0, 'indent'], 1),
        unterminated: mutate(
          ['shaderLabMaterial', 'programBlocks', 0, 'unterminated'],
          'false',
        ),
      }),
      ...fieldCases<ShaderLabMaterialFacts>('ShaderLabMaterialFacts', {
        srpEvidence: mutate(['shaderLabMaterial', 'srpEvidence'], 'true'),
        subShaderCount: mutate(['shaderLabMaterial', 'subShaderCount'], 'one'),
        hasIncludes: mutate(['shaderLabMaterial', 'hasIncludes'], 'false'),
        lineEnding: mutate(['shaderLabMaterial', 'lineEnding'], '\r'),
        cbuffers: mutate(['shaderLabMaterial', 'cbuffers'], null),
        programBlocks: mutate(['shaderLabMaterial', 'programBlocks'], null),
      }),
      ...fieldCases<ShaderContextDirectiveEntry>('ShaderContextDirectiveEntry', {
        kind: mutate(['shaderContext', 'directives', 0, 'kind'], 'pragma'),
        name: mutate(['shaderContext', 'directives', 0, 'name'], 1),
        range: mutate(['shaderContext', 'directives', 0, 'range'], null),
        conditional: mutate(['shaderContext', 'directives', 0, 'conditional'], 'false'),
        blockIndex: mutate(['shaderContext', 'directives', 0, 'blockIndex'], 'zero'),
      }),
      ...fieldCases<ShaderContextVariantPragmaEntry>('ShaderContextVariantPragmaEntry', {
        keywords: mutate(['shaderContext', 'variantPragmas', 0, 'keywords'], [1]),
        stage: mutate(['shaderContext', 'variantPragmas', 0, 'stage'], 'pixel'),
        conditional: mutate(
          ['shaderContext', 'variantPragmas', 0, 'conditional'],
          'false',
        ),
        blockIndex: mutate(['shaderContext', 'variantPragmas', 0, 'blockIndex'], 'zero'),
      }),
      ...fieldCases<ShaderContextStageEntry>('ShaderContextStageEntry', {
        stage: mutate(['shaderContext', 'programs', 0, 'stages', 0, 'stage'], 'pixel'),
        entryPoint: mutate(
          ['shaderContext', 'programs', 0, 'stages', 0, 'entryPoint'],
          1,
        ),
        defines: mutate(['shaderContext', 'programs', 0, 'stages', 0, 'defines'], [1]),
      }),
      ...fieldCases<ShaderProgramContextEntry>('ShaderProgramContextEntry', {
        blockIndex: mutate(['shaderContext', 'programs', 0, 'blockIndex'], 'zero'),
        shaderName: mutate(['shaderContext', 'programs', 0, 'shaderName'], 1),
        subShaderIndex: mutate(['shaderContext', 'programs', 0, 'subShaderIndex'], 'zero'),
        passIndex: mutate(['shaderContext', 'programs', 0, 'passIndex'], 'zero'),
        passName: mutate(['shaderContext', 'programs', 0, 'passName'], 1),
        stages: mutate(['shaderContext', 'programs', 0, 'stages'], null),
        sharedBlockIndices: mutate(
          ['shaderContext', 'programs', 0, 'sharedBlockIndices'],
          ['one'],
        ),
      }),
      ...fieldCases<ShaderContextSourceFacts>('ShaderContextSourceFacts', {
        directives: mutate(['shaderContext', 'directives'], null),
        variantPragmas: mutate(['shaderContext', 'variantPragmas'], null),
        programs: mutate(['shaderContext', 'programs'], null),
      }),
      ...fieldCases<FileIndex>('FileIndex', {
        uri: mutate(['uri'], 'file:///foreign.shader'),
        symbols: mutate(['symbols'], null),
        references: mutate(['references'], null),
        typeInferences: mutate(['typeInferences'], null),
        structure: mutate(['structure'], null),
        properties: mutate(['properties'], null),
        shaderLabNames: mutate(['shaderLabNames'], null),
        shaderLabMaterial: mutate(['shaderLabMaterial'], null),
        shaderContext: mutate(['shaderContext'], null),
      }),
      {
        label: 'recursive ShaderLabStructureNode child',
        path: ['structure', 'shaders', 0, 'children', 1, 'children', 0, 'headerLine'],
        invalid: 'six',
      },
      {
        label: 'unknown active-schema field',
        path: ['futureFacts'],
        invalid: [],
      },
    ];

    expect(decodePersistedFileIndex(index, index.uri)).toBe(index);
    expect(new Set(malformed.map((candidate) => candidate.label)).size).toBe(malformed.length);
    for (const candidate of malformed) {
      expect(
        decodePersistedFileIndex(
          malformedIndex(index, candidate.path, candidate.invalid),
          index.uri,
        ),
        candidate.label,
      ).toBeNull();
    }
  });

  it('serves cached Property facts after restore and publication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-property-publication-'));
    const store = new CacheStore(dir);
    const uri = workspaceLocation.fileUri('Assets', 'Material.shader');
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
        workspaceFolderUri: workspaceLocation.folderUri,
        unityProjectRoot: workspaceLocation.rootPath,
        createdAt: 1,
        fingerprint,
        files: [{ uri, mtimeMs: 1, size: text.length, index }],
      });
      const restored = (await store.load(fingerprint))?.files[0]?.index;
      if (!restored) throw new Error('Expected a restored FileIndex');

      const settings = DEFAULT_SETTINGS;
      const builder = IndexedRevisionBuilder.create({
        folderUri: workspaceLocation.folderUri,
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
