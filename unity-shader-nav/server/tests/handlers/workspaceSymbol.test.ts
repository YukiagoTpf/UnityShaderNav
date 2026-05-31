import { describe, expect, it } from 'vitest';
import {
  SymbolKind,
  type Connection,
  type SymbolInformation,
  type WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import type { FileIndex, SymbolEntry } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex } from '../../src/index';
import { registerWorkspaceSymbolHandler } from '../../src/handlers/workspaceSymbol';

type Handler = (params: WorkspaceSymbolParams) => Promise<SymbolInformation[]>;

function makeConnection(): { connection: Connection; getHandler: () => Handler | undefined } {
  let handler: Handler | undefined;
  const connection = {
    onWorkspaceSymbol(fn: Handler) {
      handler = fn;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return { connection, getHandler: () => handler };
}

interface FakeWorkspace {
  index: { global: GlobalSymbolIndex };
  settings: { findReferences: { includePackages: boolean } };
  packages: { isInPackages: (uri: string) => boolean };
}

function makeWorkspace(
  files: FileIndex[],
  options: { includePackages?: boolean; packageUris?: ReadonlySet<string> } = {},
): FakeWorkspace {
  const global = new GlobalSymbolIndex();
  for (const file of files) global.upsert(file);
  const packageUris = options.packageUris ?? new Set<string>();
  return {
    index: { global },
    settings: { findReferences: { includePackages: options.includePackages ?? false } },
    packages: { isInPackages: (uri: string) => packageUris.has(uri) },
  };
}

function file(uri: string, symbols: SymbolEntry[]): FileIndex {
  return { uri, symbols, references: [] };
}

function sym(
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

function makeManager(workspaces: FakeWorkspace[]): never {
  return { async readyList() { return workspaces; } } as never;
}

describe('registerWorkspaceSymbolHandler', () => {
  it('returns case-insensitive substring matches', async () => {
    const { connection, getHandler } = makeConnection();
    const uri = 'file:///proj/a.hlsl';
    const workspace = makeWorkspace([
      file(uri, [
        sym('MainTex', 'variable', uri, 0),
        sym('Frag', 'function', uri, 5),
      ]),
    ]);
    registerWorkspaceSymbolHandler(connection, makeManager([workspace]));

    const result = await getHandler()!({ query: 'main' });

    expect(result).toMatchObject([{ name: 'MainTex', kind: SymbolKind.Variable }]);
  });

  it('returns [] for an empty query', async () => {
    const { connection, getHandler } = makeConnection();
    const uri = 'file:///proj/a.hlsl';
    const workspace = makeWorkspace([file(uri, [sym('Anything', 'function', uri, 0)])]);
    registerWorkspaceSymbolHandler(connection, makeManager([workspace]));

    await expect(getHandler()!({ query: '' })).resolves.toEqual([]);
    await expect(getHandler()!({ query: '   ' })).resolves.toEqual([]);
  });

  it('filters out parameters, locals, and unnamed symbols', async () => {
    const { connection, getHandler } = makeConnection();
    const uri = 'file:///proj/a.hlsl';
    const workspace = makeWorkspace([
      file(uri, [
        sym('Frag', 'function', uri, 0),
        sym('x', 'parameter', uri, 1),
        sym('y', 'localVariable', uri, 2),
        sym('   ', 'variable', uri, 3),
      ]),
    ]);
    registerWorkspaceSymbolHandler(connection, makeManager([workspace]));

    await expect(getHandler()!({ query: 'x' })).resolves.toEqual([]);
    await expect(getHandler()!({ query: 'y' })).resolves.toEqual([]);
    const all = await getHandler()!({ query: 'f' });
    expect(all.map((r) => r.name)).toEqual(['Frag']);
  });

  it('excludes package symbols by default and includes them when settings opt in', async () => {
    const { connection, getHandler } = makeConnection();
    const userUri = 'file:///proj/a.hlsl';
    const packageUri = 'file:///proj/Library/PackageCache/foo/bar.hlsl';
    const fileIndexes = [
      file(userUri, [sym('UserFn', 'function', userUri, 0)]),
      file(packageUri, [sym('PackageFn', 'function', packageUri, 0)]),
    ];

    const defaults = makeWorkspace(fileIndexes, { packageUris: new Set([packageUri]) });
    registerWorkspaceSymbolHandler(connection, makeManager([defaults]));
    const defaultResult = await getHandler()!({ query: 'fn' });
    expect(defaultResult.map((r) => r.name)).toEqual(['UserFn']);

    const opened = makeWorkspace(fileIndexes, {
      includePackages: true,
      packageUris: new Set([packageUri]),
    });
    const second = makeConnection();
    registerWorkspaceSymbolHandler(second.connection, makeManager([opened]));
    const openedResult = await second.getHandler()!({ query: 'fn' });
    expect(openedResult.map((r) => r.name)).toEqual(['PackageFn', 'UserFn']);
  });

  it('returns separate locations for duplicate names across files', async () => {
    const { connection, getHandler } = makeConnection();
    const a = 'file:///proj/a.hlsl';
    const b = 'file:///proj/b.hlsl';
    const workspace = makeWorkspace([
      file(a, [sym('Frag', 'function', a, 0)]),
      file(b, [sym('Frag', 'function', b, 0)]),
    ]);
    registerWorkspaceSymbolHandler(connection, makeManager([workspace]));

    const result = await getHandler()!({ query: 'frag' });

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.location.uri).sort()).toEqual([a, b]);
  });

  it('aggregates results across multiple ready workspaces', async () => {
    const { connection, getHandler } = makeConnection();
    const aUri = 'file:///proj-a/a.hlsl';
    const bUri = 'file:///proj-b/b.hlsl';
    const ws1 = makeWorkspace([file(aUri, [sym('AlphaFn', 'function', aUri, 0)])]);
    const ws2 = makeWorkspace([file(bUri, [sym('AlphaStruct', 'struct', bUri, 0)])]);
    registerWorkspaceSymbolHandler(connection, makeManager([ws1, ws2]));

    const result = await getHandler()!({ query: 'alpha' });

    expect(result.map((r) => r.name)).toEqual(['AlphaFn', 'AlphaStruct']);
    expect(result.map((r) => r.kind)).toEqual([SymbolKind.Function, SymbolKind.Struct]);
  });

  it('does not throw when a workspace has an empty index (cold workspace)', async () => {
    const { connection, getHandler } = makeConnection();
    const populatedUri = 'file:///proj/a.hlsl';
    const cold = makeWorkspace([]);
    const populated = makeWorkspace([file(populatedUri, [sym('Frag', 'function', populatedUri, 0)])]);
    registerWorkspaceSymbolHandler(connection, makeManager([cold, populated]));

    const result = await getHandler()!({ query: 'frag' });

    expect(result.map((r) => r.name)).toEqual(['Frag']);
  });

  it('uses parentType as containerName for struct members and basename otherwise', async () => {
    const { connection, getHandler } = makeConnection();
    const uri = 'file:///proj/sub/dir/material.hlsl';
    const workspace = makeWorkspace([
      file(uri, [
        sym('color', 'structMember', uri, 1, { parentType: 'Surface' }),
        sym('Frag', 'function', uri, 5),
      ]),
    ]);
    registerWorkspaceSymbolHandler(connection, makeManager([workspace]));

    const member = (await getHandler()!({ query: 'color' }))[0];
    expect(member.containerName).toBe('Surface');
    expect(member.kind).toBe(SymbolKind.Field);

    const fn = (await getHandler()!({ query: 'frag' }))[0];
    expect(fn.containerName).toBe('material.hlsl');
    expect(fn.kind).toBe(SymbolKind.Function);
  });

  it('returns results in deterministic order (name, uri, line)', async () => {
    const { connection, getHandler } = makeConnection();
    const a = 'file:///proj/a.hlsl';
    const b = 'file:///proj/b.hlsl';
    const workspace = makeWorkspace([
      file(a, [
        sym('Bravo', 'function', a, 0),
        sym('Alpha', 'function', a, 10),
        sym('Alpha', 'function', a, 2),
      ]),
      file(b, [sym('Alpha', 'function', b, 0)]),
    ]);
    registerWorkspaceSymbolHandler(connection, makeManager([workspace]));

    const result = await getHandler()!({ query: 'a' });

    expect(result.map((r) => `${r.name}@${r.location.uri}:${r.location.range.start.line}`)).toEqual([
      `Alpha@${a}:2`,
      `Alpha@${a}:10`,
      `Alpha@${b}:0`,
      `Bravo@${a}:0`,
    ]);
  });
});
