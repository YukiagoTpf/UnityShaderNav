import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
import { LSPErrorCodes } from 'vscode-languageserver/node';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import {
  createSuggestionCandidateSelector,
  type ShaderSuggestion,
  type SuggestionCandidateSelection,
  type SuggestionCandidateSelector,
  type SuggestionContext,
} from '../../src/suggestions';
import type { FileProbe } from '../../src/include';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SuggestionCandidateSelector', () => {
  it('observes in-flight cancellation while scanning mostly nonmatching symbols', async () => {
    const uri = 'file:///project/LongPrefixScan.hlsl';
    let scanned = 0;
    const symbols = Array.from({ length: 4097 }, (_, index) => {
      const name = index === 4096 ? 'MatchOne' : `Noise${index}`;
      const entry = symbol(name, 'variable', uri, index);
      Object.defineProperty(entry, 'name', {
        enumerable: true,
        get() {
          scanned++;
          return name;
        },
      });
      return entry;
    });
    const selector = selectorFor([{ uri, references: [], symbols }]);
    scanned = 0;
    const cancellation = new CancellationTokenSource();
    const cancellationTask = setImmediate(() => cancellation.cancel());

    try {
      await expect(selector.select({
        uri,
        position: { line: 5000, character: 0 },
        query: { kind: 'completion', context: context('Match') },
        cancellation: cancellation.token,
      })).rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
      expect(scanned).toBeGreaterThan(0);
      expect(scanned).toBeLessThan(symbols.length);
    } finally {
      clearImmediate(cancellationTask);
      cancellation.dispose();
    }
  });

  it('observes in-flight cancellation during a long completion candidate loop', async () => {
    const uri = 'file:///project/LongCompletion.hlsl';
    const cancellation = new CancellationTokenSource();
    let cancellationTask: ReturnType<typeof setImmediate> | undefined;
    let materialized = 0;
    const symbols = Array.from({ length: 4096 }, (_, index) => {
      const entry = symbol(`Match${index}`, 'variable', uri, index);
      Object.defineProperty(entry, 'declaredType', {
        enumerable: true,
        get() {
          materialized++;
          if (materialized === 1) {
            cancellationTask = setImmediate(() => cancellation.cancel());
          }
          return 'float';
        },
      });
      return entry;
    });
    const selector = selectorFor([{ uri, references: [], symbols }]);

    try {
      await expect(selector.select({
        uri,
        position: { line: 5000, character: 0 },
        query: { kind: 'completion', context: context('Match') },
        cancellation: cancellation.token,
      })).rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
      expect(materialized).toBeGreaterThan(0);
      expect(materialized).toBeLessThan(symbols.length);
    } finally {
      if (cancellationTask) clearImmediate(cancellationTask);
      cancellation.dispose();
    }
  });

  it('cancels only one waiter while retaining revision-owned include visibility work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cancel-visible-chain-'));
    const mainPath = join(root, 'Main.hlsl');
    const visiblePath = join(root, 'Visible.hlsl');
    await Promise.all([
      writeFile(mainPath, '#include "Visible.hlsl"'),
      writeFile(visiblePath, ''),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const visibleUri = pathToFileURL(visiblePath).href;
      const main: FileIndex = {
        uri: mainUri,
        references: [includeReference(mainUri, 'Visible.hlsl')],
        symbols: [],
      };
      const visible: FileIndex = {
        uri: visibleUri,
        references: [],
        symbols: [symbol('VisibleMatch', 'variable', visibleUri, 0)],
      };
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const index of [main, visible]) {
        store.set(index.uri, index);
        global.upsert(index);
      }
      const probeStarted = deferred<void>();
      const releaseProbe = deferred<void>();
      let existsCalls = 0;
      const probe: FileProbe = {
        async exists(path) {
          existsCalls++;
          probeStarted.resolve();
          await releaseProbe.promise;
          return path === visiblePath;
        },
        listDir: (path) => readdir(path),
      };
      const selector = createSuggestionCandidateSelector(
        { store, global },
        createIncludeChain(store, {
          unityProjectRoot: undefined,
          includeDirectories: [],
        }, probe),
      );
      const cancellation = new CancellationTokenSource();
      const first = selector.select({
        uri: mainUri,
        position: { line: 1, character: 0 },
        query: { kind: 'completion', context: context('Visible') },
        cancellation: cancellation.token,
      });
      await probeStarted.promise;
      cancellation.cancel();
      await expect(first).rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
      expect(existsCalls).toBe(1);

      releaseProbe.resolve();
      const second = await completion(selector, mainUri, 'Visible');
      expect(projectSuggestions(second).map((item) => item.name)).toEqual(['VisibleMatch']);
      expect(existsCalls).toBe(1);
      cancellation.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes completion candidates only for matching current and visible names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-prefix-allocation-'));
    const mainPath = join(root, 'Main.hlsl');
    const visiblePath = join(root, 'Visible.hlsl');
    await Promise.all([
      writeFile(mainPath, '#include "Visible.hlsl"'),
      writeFile(visiblePath, ''),
    ]);

    try {
      const mainUri = pathToFileURL(mainPath).href;
      const visibleUri = pathToFileURL(visiblePath).href;
      let materialized = 0;
      const tracked = (name: string, uri: string, line: number): SymbolEntry => {
        const entry = symbol(name, 'variable', uri, line);
        Object.defineProperty(entry, 'declaredType', {
          enumerable: true,
          get() {
            materialized++;
            return 'float';
          },
        });
        return entry;
      };
      const main: FileIndex = {
        uri: mainUri,
        references: [includeReference(mainUri, 'Visible.hlsl')],
        symbols: [
          ...Array.from({ length: 500 }, (_, index) => (
            tracked(`CurrentNoise${index}`, mainUri, index)
          )),
          tracked('MatchCurrent', mainUri, 501),
        ],
      };
      const visible: FileIndex = {
        uri: visibleUri,
        references: [],
        symbols: [
          ...Array.from({ length: 500 }, (_, index) => (
            tracked(`VisibleNoise${index}`, visibleUri, index)
          )),
          tracked('MatchVisible', visibleUri, 501),
        ],
      };
      const selection = await completion(selectorFor([main, visible]), mainUri, 'Match', 600);

      expect(projectSuggestions(selection).map((item) => item.name))
        .toEqual(['MatchCurrent', 'MatchVisible']);
      expect(materialized).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
          target: { kind: 'free', name: 'Overload' },
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
          target: { kind: 'free', name: 'Overload' },
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
          target: { kind: 'free', name: 'Overload' },
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
          target: { kind: 'free', name: 'normalize' },
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
          { ...fn('Shade', typesUri, 6), parentType: 'Surface' },
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
        .toEqual(['localMember', 'positionWS', 'brdfData', 'Shade']);
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

  it('selects only the receiver type method overloads for member signatures', async () => {
    const uri = 'file:///project/Main.hlsl';
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [
        symbol('surface', 'parameter', uri, 1, {
          declaredType: 'Surface',
          scopeRange,
        }),
        symbol('lights', 'parameter', uri, 1, {
          declaredType: 'Light',
          scopeRange,
        }),
        symbol('brdf', 'structMember', uri, 1, {
          parentType: 'Surface',
          declaredType: 'Brdf',
        }),
        fn('Shade', uri, 2, [{ type: 'float', name: 'x' }]),
        { ...fn('Shade', uri, 3, [{ type: 'float', name: 'x' }]), parentType: 'Light' },
        { ...fn('Shade', uri, 4, [{ type: 'float', name: 'x' }]), parentType: 'Surface' },
        {
          ...fn('Shade', uri, 5, [
            { type: 'float', name: 'x' },
            { type: 'float', name: 'y' },
          ]),
          parentType: 'Surface',
        },
        { ...fn('Shade', uri, 6, [{ type: 'float', name: 'x' }]), parentType: 'Surface' },
        { ...fn('Evaluate', uri, 7), parentType: 'Brdf' },
        { ...fn('Illuminate', uri, 8), parentType: 'Light' },
      ],
    };

    const selector = selectorFor([index]);
    const selection = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        target: { kind: 'member', receiver: 'surface', name: 'Shade' },
        activeParameter: 1,
      },
    });

    expect(selection?.suggestions.map((item) => ({
      parentType: item.parentType,
      parameterCount: item.parameters?.length,
    }))).toEqual([
      { parentType: 'Surface', parameterCount: 1 },
      { parentType: 'Surface', parameterCount: 2 },
    ]);
    expect(selection?.activeSuggestion).toBe(1);

    const freeSignatures = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        target: { kind: 'free', name: 'Shade' },
        activeParameter: 0,
      },
    });
    expect(freeSignatures?.suggestions).toEqual([
      expect.objectContaining({ name: 'Shade', parentType: undefined }),
    ]);

    const ordinaryCompletion = await completion(selector, uri, 'Shade');
    expect(projectSuggestions(ordinaryCompletion)).toEqual([
      expect.objectContaining({ name: 'Shade', parentType: undefined }),
    ]);

    const nested = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        target: { kind: 'member', receiver: 'surface.brdf', name: 'Evaluate' },
        activeParameter: 0,
      },
    });
    expect(nested?.suggestions).toEqual([
      expect.objectContaining({ name: 'Evaluate', parentType: 'Brdf' }),
    ]);

    const array = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        target: { kind: 'member', receiver: 'lights[i]', name: 'Illuminate' },
        activeParameter: 0,
      },
    });
    expect(array?.suggestions).toEqual([
      expect.objectContaining({ name: 'Illuminate', parentType: 'Light' }),
    ]);

    const unknown = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        target: { kind: 'member', receiver: 'missing', name: 'Shade' },
        activeParameter: 0,
      },
    });
    expect(unknown?.suggestions).toEqual([]);
  });

  it('falls back to all compatible builtin member signature overloads', async () => {
    const uri = 'file:///project/TextureSignature.hlsl';
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [symbol('texture', 'parameter', uri, 1, {
        declaredType: 'Texture2D<float4>',
        scopeRange,
      })],
    };
    const selector = selectorFor([index]);

    const selection = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        target: { kind: 'member', receiver: 'texture', name: 'Sample' },
        activeParameter: 2,
      },
    });

    expect(selection?.suggestions.map((item) => ({
      source: item.source,
      parentType: item.parentType,
      parameterCount: item.parameters?.length,
    }))).toEqual([
      { source: 'builtin', parentType: 'Texture2D', parameterCount: 2 },
      { source: 'builtin', parentType: 'Texture2D', parameterCount: 3 },
    ]);
    expect(selection?.activeSuggestion).toBe(1);
  });

  it('prefers same-name project members over builtin completion and signatures', async () => {
    const uri = 'file:///project/TextureOverride.hlsl';
    const projectSample = {
      ...fn('Sample', uri, 2, [{ type: 'ProjectSampler', name: 'sampler' }]),
      parentType: 'Texture2D<float4>',
    };
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [
        symbol('texture', 'parameter', uri, 1, {
          declaredType: 'Texture2D<float4>',
          scopeRange,
        }),
        projectSample,
      ],
    };
    const selector = selectorFor([index]);
    const memberCompletion = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: { kind: 'member', receiver: 'texture', prefix: 'Sam' },
    });
    const memberSignature = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        target: { kind: 'member', receiver: 'texture', name: 'Sample' },
        activeParameter: 0,
      },
    });

    expect(memberCompletion?.suggestions.filter((item) => item.name === 'Sample')).toEqual([
      expect.objectContaining({ source: 'project', parentType: 'Texture2D<float4>' }),
    ]);
    expect(memberSignature?.suggestions).toEqual([
      expect.objectContaining({
        source: 'project',
        parameters: [{ type: 'ProjectSampler', name: 'sampler' }],
      }),
    ]);
  });

  it('does not leak builtin members to unknown receivers or free queries', async () => {
    const uri = 'file:///project/UnknownReceiver.hlsl';
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [symbol('unknown', 'parameter', uri, 1, {
        declaredType: 'UserDefinedType',
        scopeRange,
      })],
    };
    const selector = selectorFor([index]);
    const unknownMember = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: { kind: 'member', receiver: 'unknown', prefix: 'Sam' },
    });
    const freeSignature = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: {
        kind: 'signature',
        context: context(),
        target: { kind: 'free', name: 'Sample' },
        activeParameter: 0,
      },
    });
    const freeCompletion = await completion(selector, uri, 'Sam');

    expect(unknownMember?.suggestions).toEqual([]);
    expect(freeSignature?.suggestions).toEqual([]);
    expect(freeCompletion.suggestions.map((item) => item.name)).not.toContain('Sample');
  });

  it('completes members when call-assignment overloads agree on the receiver type', async () => {
    const uri = 'file:///project/Main.hlsl';
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [
        symbol('positionWS', 'structMember', uri, 0, {
          parentType: 'Surface',
          declaredType: 'float3',
        }),
        { ...fn('MakeSurface', uri, 1), returnType: 'Surface' },
        {
          ...fn('MakeSurface', uri, 2, [{ type: 'float3', name: 'position' }]),
          returnType: 'Surface',
        },
      ],
      typeInferences: [{
        receiver: 'surface',
        callName: 'MakeSurface',
        assignmentRange: {
          start: { line: 8, character: 2 },
          end: { line: 8, character: 25 },
        },
        scope: 'frag',
        scopeRange,
      }],
    };
    const selector = selectorFor([index]);

    const selection = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: { kind: 'member', receiver: 'surface', prefix: 'pos' },
    });

    expect(selection?.suggestions).toEqual([
      expect.objectContaining({
        name: 'positionWS',
        source: 'project',
        parentType: 'Surface',
      }),
    ]);
  });

  it('completes generic Texture2D builtin methods once per method name', async () => {
    const uri = 'file:///project/Texture.hlsl';
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [symbol('texture', 'parameter', uri, 1, {
        declaredType: 'Texture2D<float4>',
        scopeRange,
      })],
    };
    const selector = selectorFor([index]);

    const selection = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: { kind: 'member', receiver: 'texture', prefix: 'Sam' },
    });

    expect(selection?.suggestions.filter((item) => item.name === 'Sample')).toEqual([
      expect.objectContaining({
        name: 'Sample',
        kind: 'function',
        source: 'builtin',
        parentType: 'Texture2D',
      }),
    ]);
    expect(selection?.suggestions.map((item) => item.name)).toEqual(expect.arrayContaining([
      'Sample',
      'SampleLevel',
      'SampleBias',
      'SampleGrad',
      'SampleCmp',
    ]));
  });

  it('projects float4 swizzles as typed builtin struct members', async () => {
    const uri = 'file:///project/Vector.hlsl';
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [symbol('color', 'parameter', uri, 1, {
        declaredType: 'float4',
        scopeRange,
      })],
    };
    const selector = selectorFor([index]);

    const selection = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: { kind: 'member', receiver: 'color', prefix: 'xy' },
    });

    expect(selection?.suggestions).toContainEqual(expect.objectContaining({
      name: 'xy',
      kind: 'structMember',
      source: 'builtin',
      declaredType: 'float2',
      parentType: 'float4',
    }));
  });

  it('projects bounded non-square matrix components as typed struct members', async () => {
    const uri = 'file:///project/Matrix.hlsl';
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [symbol('transform', 'parameter', uri, 1, {
        declaredType: 'float3x4',
        scopeRange,
      })],
    };
    const selector = selectorFor([index]);

    const selection = await selector.select({
      uri,
      position: { line: 10, character: 0 },
      query: { kind: 'member', receiver: 'transform', prefix: '_m2' },
    });

    expect(selection?.suggestions).toContainEqual(expect.objectContaining({
      name: '_m23',
      kind: 'structMember',
      source: 'builtin',
      declaredType: 'float',
      parentType: 'float3x4',
    }));
    expect(selection?.suggestions.map((item) => item.name)).not.toContain('_m30');
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
        target: { kind: 'free', name: 'Missing' },
        activeParameter: 0,
      },
    })).resolves.toEqual({ suggestions: [] });
  });
});
