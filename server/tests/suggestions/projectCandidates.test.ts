import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  FileIndex,
  FunctionSymbolEntry,
  ReferenceEntry,
  SymbolEntry,
} from '@unity-shader-nav/shared';
import { createIncludeChain } from '../../src/include';
import { describe, expect, it } from 'vitest';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import {
  createSuggestionCandidateSelector,
  type ShaderSuggestion,
  type SuggestionCandidateSelection,
  type SuggestionCandidateSelector,
  type SuggestionContext,
} from '../../src/suggestions';

const scopeRange = {
  start: { line: 1, character: 0 },
  end: { line: 20, character: 0 },
};

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
        start: { line, character: 2 },
        end: { line, character: 2 + name.length },
      },
    },
    ...extras,
  };
}

function fn(
  name: string,
  uri: string,
  line: number,
  parameters: Array<{ type: string; name: string }> = [],
): FunctionSymbolEntry {
  return {
    ...symbol(name, 'function', uri, line),
    kind: 'function',
    returnType: 'float4',
    parameters: parameters.map((parameter, index) => ({
      ...parameter,
      range: {
        start: { line, character: index },
        end: { line, character: index + 1 },
      },
    })),
  };
}

function includeReference(uri: string, name: string): ReferenceEntry {
  return {
    name,
    context: 'include',
    location: {
      uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: name.length },
      },
    },
  };
}

function selectorFor(indexes: readonly FileIndex[]): SuggestionCandidateSelector {
  const store = new IndexStore();
  const global = new GlobalSymbolIndex();
  for (const index of indexes) {
    store.set(index.uri, index);
    global.upsert(index);
  }
  return createSuggestionCandidateSelector(
    { store, global },
    createIncludeChain(store, {
      unityProjectRoot: undefined,
      includeDirectories: [],
    }),
  );
}

function context(prefix = ''): SuggestionContext {
  return {
    kind: 'hlslCode',
    prefix: {
      text: prefix,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: prefix.length },
      },
    },
  };
}

async function completion(
  selector: SuggestionCandidateSelector,
  uri: string,
  prefix = '',
  line = 10,
): Promise<SuggestionCandidateSelection> {
  return (await selector.select({
    uri,
    position: { line, character: 0 },
    query: { kind: 'completion', context: context(prefix) },
  }))!;
}

function projectSuggestions(
  selection: SuggestionCandidateSelection,
): readonly ShaderSuggestion[] {
  return selection.suggestions.filter((suggestion) => suggestion.source === 'project');
}

describe('SuggestionCandidateSelector', () => {
  it('owns prefix, scope, declaration order, proximity, rank, and display dedupe', async () => {
    const uri = 'file:///project/Main.hlsl';
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [
        fn('SameFile', uri, 0),
        symbol('value', 'parameter', uri, 1, {
          declaredType: 'float',
          scopeRange,
        }),
        symbol('value', 'localVariable', uri, 3, {
          declaredType: 'float2',
          scopeRange,
        }),
        symbol('value', 'localVariable', uri, 7, {
          declaredType: 'float3',
          scopeRange,
        }),
        symbol('otherParameter', 'parameter', uri, 2, {
          declaredType: 'half',
          scopeRange,
        }),
        symbol('futureLocal', 'localVariable', uri, 12, {
          scopeRange,
        }),
        symbol('outOfScope', 'localVariable', uri, 4, {
          scopeRange: {
            start: { line: 1, character: 0 },
            end: { line: 5, character: 0 },
          },
        }),
        symbol('_Color', 'variable', uri, 4, { declaredType: 'float4' }),
        symbol('_Color', 'variable', uri, 5, { declaredType: 'half4' }),
        fn('Lighting', uri, 6, [{ type: 'float3', name: 'normalWS' }]),
        fn('Lighting', uri, 8, [{ type: 'half3', name: 'normalWS' }]),
      ],
    };
    const selector = selectorFor([index]);

    const suggestions = projectSuggestions(await completion(selector, uri));
    expect(suggestions.map((item) => item.name)).toEqual([
      'value',
      'otherParameter',
      'SameFile',
      '_Color',
      'Lighting',
      'Lighting',
    ]);
    expect(suggestions.map((item) => item.sortText)).toEqual([
      '0_value',
      '0_otherParameter',
      '1_SameFile',
      '1__Color',
      '1_Lighting',
      '1_Lighting',
    ]);
    expect(suggestions[0]).toMatchObject({
      kind: 'localVariable',
      declaredType: 'float3',
    });
    expect(suggestions.filter((item) => item.name === '_Color')).toHaveLength(1);
    expect(suggestions.filter((item) => item.name === 'Lighting')).toHaveLength(2);

    expect(projectSuggestions(await completion(selector, uri, 'Lig'))
      .map((item) => item.name)).toEqual(['Lighting', 'Lighting']);

    expect(projectSuggestions(await completion(selector, uri, 'value', 20))
      .map((item) => item.name)).toEqual(['value']);
    expect(projectSuggestions(await completion(selector, uri, 'value', 21)))
      .toEqual([]);
  });

  it('owns transitive include visibility, stable ranking, overload identity, and project precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-project-candidates-'));
    const mainPath = join(root, 'Main.hlsl');
    const sharedPath = join(root, 'Shared.hlsl');
    const deepPath = join(root, 'Deep.hlsl');
    const hiddenPath = join(root, 'Hidden.hlsl');
    await Promise.all([
      writeFile(mainPath, '#include "Shared.hlsl"'),
      writeFile(sharedPath, '#include "Deep.hlsl"'),
      writeFile(deepPath, ''),
      writeFile(hiddenPath, ''),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const sharedUri = pathToFileURL(sharedPath).href;
      const deepUri = pathToFileURL(deepPath).href;
      const hiddenUri = pathToFileURL(hiddenPath).href;
      const main: FileIndex = {
        uri: mainUri,
        references: [includeReference(mainUri, 'Shared.hlsl')],
        symbols: [
          symbol('Overload', 'localVariable', mainUri, 4, {
            declaredType: 'ScopedType',
            scopeRange,
          }),
          fn('Current', mainUri, 0),
          fn('Overload', mainUri, 1, [{ type: 'float', name: 'a' }]),
          fn('normalize', mainUri, 2, [{ type: 'ProjectType', name: 'value' }]),
          symbol('_Color', 'variable', mainUri, 3),
        ],
      };
      const shared: FileIndex = {
        uri: sharedUri,
        references: [includeReference(sharedUri, 'Deep.hlsl')],
        symbols: [
          fn('Shared', sharedUri, 0),
          fn('Overload', sharedUri, 1, [
            { type: 'float', name: 'a' },
            { type: 'float', name: 'b' },
          ]),
          symbol('_Color', 'variable', sharedUri, 2),
        ],
      };
      const deep: FileIndex = {
        uri: deepUri,
        references: [],
        symbols: [
          fn('Deep', deepUri, 0),
          fn('Overload', deepUri, 1, [
            { type: 'float', name: 'a' },
            { type: 'float', name: 'b' },
          ]),
        ],
      };
      const hidden: FileIndex = {
        uri: hiddenUri,
        references: [],
        symbols: [fn('Hidden', hiddenUri, 0), fn('Overload', hiddenUri, 1)],
      };
      const selector = selectorFor([main, shared, deep, hidden]);

      const selection = await completion(selector, mainUri);
      const project = projectSuggestions(selection);
      expect(project.map((item) => item.name)).toEqual([
        'Overload',
        'Current',
        'Overload',
        'normalize',
        '_Color',
        'Shared',
        'Overload',
        'Deep',
        'Overload',
      ]);
      expect(project.map((item) => item.sortText)).toEqual([
        '0_Overload',
        '1_Current',
        '1_Overload',
        '1_normalize',
        '1__Color',
        '2_Shared',
        '2_Overload',
        '2_Deep',
        '2_Overload',
      ]);
      expect(project.some((item) => item.name === 'Hidden')).toBe(false);
      expect(project.filter((item) => item.name === '_Color')).toHaveLength(1);
      expect(project.filter((item) => item.name === 'Overload')).toHaveLength(4);
      expect(project.filter((item) => item.name === 'Overload').map((item) => item.kind))
        .toEqual(['localVariable', 'function', 'function', 'function']);
      expect(selection.suggestions.filter((item) => item.name === 'normalize'))
        .toEqual([expect.objectContaining({ source: 'project' })]);

      const signatures = await selector.select({
        uri: mainUri,
        position: { line: 10, character: 0 },
        query: {
          kind: 'signature',
          context: context(),
          name: 'Overload',
          activeParameter: 1,
        },
      });
      expect(signatures?.suggestions.map((item) => item.parameters?.length))
        .toEqual([1, 2, 2]);
      expect(signatures?.suggestions.map((item) => item.sortText))
        .toEqual(['1_Overload', '2_Overload', '2_Overload']);
      expect(signatures?.activeSuggestion).toBe(1);

      const firstArgument = await selector.select({
        uri: mainUri,
        position: { line: 10, character: 0 },
        query: {
          kind: 'signature',
          context: context(),
          name: 'Overload',
          activeParameter: 0,
        },
      });
      expect(firstArgument?.activeSuggestion).toBe(0);

      const noCompatibleArity = await selector.select({
        uri: mainUri,
        position: { line: 10, character: 0 },
        query: {
          kind: 'signature',
          context: context(),
          name: 'Overload',
          activeParameter: 3,
        },
      });
      expect(noCompatibleArity?.activeSuggestion).toBe(0);

      const projectWinsBuiltinSignature = await selector.select({
        uri: mainUri,
        position: { line: 10, character: 0 },
        query: {
          kind: 'signature',
          context: context(),
          name: 'normalize',
          activeParameter: 0,
        },
      });
      expect(projectWinsBuiltinSignature?.suggestions).toEqual([
        expect.objectContaining({
          name: 'normalize',
          source: 'project',
          parameters: [{ type: 'ProjectType', name: 'value' }],
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('owns root, array, nested, prefix-filtered, and include-visible member inference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-member-candidates-'));
    const mainPath = join(root, 'Main.hlsl');
    const typesPath = join(root, 'Types.hlsl');
    const hiddenPath = join(root, 'Hidden.hlsl');
    await Promise.all([
      writeFile(mainPath, '#include "Types.hlsl"'),
      writeFile(typesPath, ''),
      writeFile(hiddenPath, ''),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const typesUri = pathToFileURL(typesPath).href;
      const hiddenUri = pathToFileURL(hiddenPath).href;
      const main: FileIndex = {
        uri: mainUri,
        references: [includeReference(mainUri, 'Types.hlsl')],
        symbols: [
          symbol('surface', 'parameter', mainUri, 1, {
            declaredType: 'Surface',
            scopeRange,
          }),
          symbol('lights', 'parameter', mainUri, 2, {
            declaredType: 'Light',
            scopeRange,
          }),
          symbol('localMember', 'structMember', mainUri, 3, {
            parentType: 'Surface',
            declaredType: 'float',
          }),
        ],
      };
      const types: FileIndex = {
        uri: typesUri,
        references: [],
        symbols: [
          symbol('positionWS', 'structMember', typesUri, 1, {
            parentType: 'Surface',
            declaredType: 'float3',
          }),
          symbol('positionWS', 'structMember', typesUri, 2, {
            parentType: 'Surface',
            declaredType: 'half3',
          }),
          symbol('brdfData', 'structMember', typesUri, 3, {
            parentType: 'Surface',
            declaredType: 'Brdf',
          }),
          symbol('roughness', 'structMember', typesUri, 4, {
            parentType: 'Brdf',
            declaredType: 'float',
          }),
          symbol('color', 'structMember', typesUri, 5, {
            parentType: 'Light',
            declaredType: 'float3',
          }),
        ],
      };
      const hidden: FileIndex = {
        uri: hiddenUri,
        references: [],
        symbols: [symbol('hiddenOnly', 'structMember', hiddenUri, 1, {
          parentType: 'Surface',
        })],
      };
      const selector = selectorFor([main, types, hidden]);
      const selectMember = async (receiver: string, prefix = '') => selector.select({
        uri: mainUri,
        position: { line: 10, character: 0 },
        query: { kind: 'member', receiver, prefix },
      });

      expect((await selectMember('surface'))?.suggestions.map((item) => item.name))
        .toEqual(['localMember', 'positionWS', 'brdfData']);
      expect((await selectMember('surface', 'pos'))?.suggestions.map((item) => item.name))
        .toEqual(['positionWS']);
      expect((await selectMember('lights[i]'))?.suggestions.map((item) => item.name))
        .toEqual(['color']);
      expect((await selectMember('surface.brdfData'))?.suggestions.map((item) => item.name))
        .toEqual(['roughness']);
      expect((await selectMember('missing'))?.suggestions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing current index from an indexed query with no candidates', async () => {
    const uri = 'file:///project/Main.hlsl';
    const selector = selectorFor([{ uri, references: [], symbols: [] }]);

    await expect(selector.select({
      uri: 'file:///project/Missing.hlsl',
      position: { line: 0, character: 0 },
      query: { kind: 'completion', context: context('NoMatch') },
    })).resolves.toBeUndefined();

    await expect(selector.select({
      uri,
      position: { line: 0, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        name: 'Missing',
        activeParameter: 0,
      },
    })).resolves.toEqual({ suggestions: [] });
  });
});
