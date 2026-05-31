import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Connection, Location, ReferenceParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DEFAULT_SETTINGS, type FileIndex, type Range } from '@unity-shader-nav/shared';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerReferencesHandler } from '../../src/handlers/references';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';

const includeFixtureRoot = pathResolve(__dirname, '../include/fixtures/projectA');

function captureReferencesHandler(): {
  connection: Connection;
  handler: () => ((params: ReferenceParams) => Promise<Location[] | null>);
} {
  let handler: ((params: ReferenceParams) => Promise<Location[] | null>) | undefined;
  const connection = {
    onReferences(fn: (params: ReferenceParams) => Promise<Location[] | null>) {
      handler = fn;
      return { dispose() {} };
    },
  } as unknown as Connection;

  return {
    connection,
    handler: () => {
      if (!handler) throw new Error('references handler was not registered');
      return handler;
    },
  };
}

const defRange = {
  start: { line: 0, character: 7 },
  end: { line: 0, character: 13 },
};
const userRefRange = {
  start: { line: 1, character: 23 },
  end: { line: 1, character: 29 },
};
const packageRefRange = {
  start: { line: 2, character: 23 },
  end: { line: 2, character: 29 },
};

function contains(range: Range, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}

function tokenPosition(text: string, line: number, token: string, occurrence = 0): { line: number; character: number } {
  const lines = text.split(/\r?\n/);
  let character = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    character = lines[line].indexOf(token, from);
    if (character < 0) throw new Error(`missing token ${token} on line ${line}`);
    from = character + token.length;
  }
  return { line, character };
}

function expectedScopedLocations(index: FileIndex, name: string, scopeRange: Range): Location[] {
  const declaration = index.symbols.find(
    (symbol) =>
      symbol.name === name &&
      (symbol.kind === 'localVariable' || symbol.kind === 'parameter') &&
      symbol.scopeRange === scopeRange,
  );
  if (!declaration) throw new Error(`missing scoped declaration for ${name}`);

  const references = index.references.filter(
    (reference) =>
      reference.name === name &&
      reference.context === 'identifier' &&
      contains(scopeRange, reference.location.range.start.line, reference.location.range.start.character),
  );

  return [
    { uri: declaration.location.uri, range: declaration.location.range },
    ...references.map((reference) => ({
      uri: reference.location.uri,
      range: reference.location.range,
    })),
  ];
}

describe('registerReferencesHandler', () => {
  it('filters global references to the canonical include-visible target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-1-refs-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainPath = join(assets, 'Main.hlsl');
      const sharedPath = join(assets, 'Shared.hlsl');
      const otherUsePath = join(assets, 'OtherUse.hlsl');
      const otherSharedPath = join(assets, 'OtherShared.hlsl');
      const mainText = [
        '#include "Shared.hlsl"',
        'float4 Main() { return Helper(); }',
      ].join('\n');
      const sharedText = 'float4 Helper() { return 1; }';
      const otherUseText = [
        '#include "OtherShared.hlsl"',
        'float4 OtherUse() { return Helper(); }',
      ].join('\n');
      const otherSharedText = 'float4 Helper() { return 2; }';
      await writeFile(mainPath, mainText, 'utf8');
      await writeFile(sharedPath, sharedText, 'utf8');
      await writeFile(otherUsePath, otherUseText, 'utf8');
      await writeFile(otherSharedPath, otherSharedText, 'utf8');

      const mainUri = pathToFileURL(mainPath).href;
      const sharedUri = pathToFileURL(sharedPath).href;
      const otherUseUri = pathToFileURL(otherUsePath).href;
      const otherSharedUri = pathToFileURL(otherSharedPath).href;
      const indexes = await Promise.all([
        indexFile(mainUri, mainText),
        indexFile(sharedUri, sharedText),
        indexFile(otherUseUri, otherUseText),
        indexFile(otherSharedUri, otherSharedText),
      ]);
      const [mainIndex, sharedIndex] = indexes;
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      const globalRefs = new GlobalReferenceIndex();
      for (const index of indexes) {
        store.set(index.uri, index);
        global.upsert(index);
        globalRefs.upsert(index);
      }
      const sharedHelper = sharedIndex.symbols.find(
        (symbol) => symbol.name === 'Helper' && symbol.kind === 'function',
      );
      const mainCall = mainIndex.references.find(
        (reference) => reference.name === 'Helper' && reference.context === 'call',
      );
      if (!sharedHelper || !mainCall) {
        throw new Error('missing canonical Helper declaration/call');
      }
      const { connection, handler } = captureReferencesHandler();
      const doc = TextDocument.create(mainUri, 'hlsl', 1, mainText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === mainUri ? doc : undefined;
        },
      } as never;
      const workspace = {
        settings: DEFAULT_SETTINGS,
        packages: {
          includeCtx: { unityProjectRoot: root, includeDirectories: [] },
          isInPackages: () => false,
        },
        index: { store, global, globalRefs },
      };
      const manager = {
        async workspaceForOrCreateFile(requestedUri: string) {
          return requestedUri === mainUri ? workspace : undefined;
        },
      } as never;

      registerReferencesHandler(connection, documents, manager);

      const result = await handler()({
        textDocument: { uri: mainUri },
        position: { line: 1, character: mainText.split('\n')[1].indexOf('Helper') + 1 },
        context: { includeDeclaration: true },
      });

      expect(result).toEqual([
        { uri: sharedUri, range: sharedHelper.location.range },
        { uri: mainUri, range: mainCall.location.range },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not leak root-only same-name definitions into an include-visible target search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-1-root-only-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainPath = join(assets, 'Main.hlsl');
      const sharedPath = join(assets, 'Shared.hlsl');
      const otherPath = join(assets, 'Other.hlsl');
      const mainText = [
        '#include "Shared.hlsl"',
        'float4 Main() { return Helper(); }',
      ].join('\n');
      const sharedText = 'float4 Helper() { return 1; }';
      const otherText = [
        'float4 Helper() { return 2; }',
        'float4 Other() { return Helper(); }',
      ].join('\n');
      await writeFile(mainPath, mainText, 'utf8');
      await writeFile(sharedPath, sharedText, 'utf8');
      await writeFile(otherPath, otherText, 'utf8');

      const mainUri = pathToFileURL(mainPath).href;
      const sharedUri = pathToFileURL(sharedPath).href;
      const otherUri = pathToFileURL(otherPath).href;
      const indexes = await Promise.all([
        indexFile(mainUri, mainText),
        indexFile(sharedUri, sharedText),
        indexFile(otherUri, otherText),
      ]);
      const [mainIndex, sharedIndex] = indexes;
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      const globalRefs = new GlobalReferenceIndex();
      for (const index of indexes) {
        store.set(index.uri, index);
        global.upsert(index);
        globalRefs.upsert(index);
      }
      const sharedHelper = sharedIndex.symbols.find(
        (symbol) => symbol.name === 'Helper' && symbol.kind === 'function',
      );
      const mainCall = mainIndex.references.find(
        (reference) => reference.name === 'Helper' && reference.context === 'call',
      );
      if (!sharedHelper || !mainCall) {
        throw new Error('missing canonical Helper declaration/call');
      }
      const { connection, handler } = captureReferencesHandler();
      const doc = TextDocument.create(mainUri, 'hlsl', 1, mainText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === mainUri ? doc : undefined;
        },
      } as never;
      const workspace = {
        settings: DEFAULT_SETTINGS,
        packages: {
          includeCtx: { unityProjectRoot: root, includeDirectories: [] },
          isInPackages: () => false,
        },
        index: { store, global, globalRefs },
      };
      const manager = {
        async workspaceForOrCreateFile(requestedUri: string) {
          return requestedUri === mainUri ? workspace : undefined;
        },
      } as never;

      registerReferencesHandler(connection, documents, manager);

      const result = await handler()({
        textDocument: { uri: mainUri },
        position: { line: 1, character: mainText.split('\n')[1].indexOf('Helper') + 1 },
        context: { includeDeclaration: true },
      });

      expect(result).toEqual([
        { uri: sharedUri, range: sharedHelper.location.range },
        { uri: mainUri, range: mainCall.location.range },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns declaration and non-package references for the word under the cursor', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Use.hlsl';
    const packageUri = 'file:///project/Packages/com.example.render/Core.hlsl';
    const doc = TextDocument.create(
      uri,
      'hlsl',
      1,
      'float4 helper() { return 0; }\nfloat4 main() { return helper(); }',
    );
    const index: FileIndex = {
      uri,
      symbols: [{
        name: 'helper',
        kind: 'function',
        location: { uri, range: defRange },
      }],
      references: [{
        name: 'helper',
        context: 'call',
        location: { uri, range: userRefRange },
      }],
    };
    const packageIndex: FileIndex = {
      uri: packageUri,
      symbols: [],
      references: [{
        name: 'helper',
        context: 'call',
        location: { uri: packageUri, range: packageRefRange },
      }],
    };
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: {
        isInPackages(requestedUri: string) {
          return requestedUri === packageUri;
        },
      },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    workspace.index.globalRefs.upsert(packageIndex);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    } as never;

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 1, character: 25 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([
      { uri, range: defRange },
      { uri, range: userRefRange },
    ]);
  });

  it('returns declaration and usage references for legacy CG variables in shader blocks', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Issue8Legacy.shader';
    const text = [
      'Shader "Test/Issue8LegacyCG" {',
      '  SubShader {',
      '    Pass {',
      '      CGPROGRAM',
      '      sampler2D _MainTex;',
      '      fixed4 _Color;',
      '      half _Cutoff;',
      '      fixed4 frag() : SV_Target {',
      '        return tex2D(_MainTex, float2(0, 0)) * _Color * _Cutoff;',
      '      }',
      '      ENDCG',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'shaderlab', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    registerReferencesHandler(connection, documents, manager);

    for (const name of ['_MainTex', '_Color', '_Cutoff']) {
      const declaration = index.symbols.find(
        (symbol) => symbol.name === name && symbol.kind === 'variable',
      );
      const usage = index.references.find(
        (reference) =>
          reference.name === name &&
          reference.context === 'identifier' &&
          reference.location.range.start.line === 8,
      );
      if (!declaration || !usage) {
        throw new Error(`missing issue 8 legacy CG declaration or usage for ${name}`);
      }

      const result = await handler()({
        textDocument: { uri },
        position: tokenPosition(text, 8, name),
        context: { includeDeclaration: true },
      });

      expect(result).toEqual([
        { uri, range: declaration.location.range },
        { uri, range: usage.location.range },
      ]);
    }
  });

  it('includes package references when the setting is enabled', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Use.hlsl';
    const packageUri = 'file:///project/Packages/com.example.render/Core.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, 'float4 main() { return helper(); }');
    const workspace = {
      settings: {
        ...DEFAULT_SETTINGS,
        findReferences: { includePackages: true },
      },
      index: {
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: {
        isInPackages(requestedUri: string) {
          return requestedUri === packageUri;
        },
      },
    };
    workspace.index.globalRefs.upsert({
      uri: packageUri,
      symbols: [],
      references: [{
        name: 'helper',
        context: 'call',
        location: { uri: packageUri, range: packageRefRange },
      }],
    });
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 0, character: 25 },
      context: { includeDeclaration: false },
    });

    expect(result).toEqual([{ uri: packageUri, range: packageRefRange }]);
  });

  it('uses the resolved workspace settings when filtering package references', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project-a/Assets/Use.hlsl';
    const packageUri = 'file:///project-a/Packages/com.example.render/Core.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, 'float4 main() { return helper(); }');
    const workspace = {
      settings: {
        ...DEFAULT_SETTINGS,
        findReferences: { includePackages: true },
      },
      index: {
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: {
        isInPackages(requestedUri: string) {
          return requestedUri === packageUri;
        },
      },
    };
    workspace.index.globalRefs.upsert({
      uri: packageUri,
      symbols: [],
      references: [{
        name: 'helper',
        context: 'call',
        location: { uri: packageUri, range: packageRefRange },
      }],
    });
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 0, character: 25 },
      context: { includeDeclaration: false },
    });

    expect(result).toEqual([{ uri: packageUri, range: packageRefRange }]);
  });

  it('excludes package declarations when includeDeclaration is true but Packages are disabled', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Use.hlsl';
    const packageUri = 'file:///project/Packages/com.example.render/Core.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, 'float4 main() { return helper(); }');
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: {
        isInPackages(requestedUri: string) {
          return requestedUri === packageUri;
        },
      },
    };
    workspace.index.global.upsert({
      uri: packageUri,
      references: [],
      symbols: [{
        name: 'helper',
        kind: 'function',
        location: { uri: packageUri, range: defRange },
      }],
    });
    workspace.index.globalRefs.upsert({
      uri,
      symbols: [],
      references: [{
        name: 'helper',
        context: 'call',
        location: { uri, range: userRefRange },
      }],
    });
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 0, character: 25 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([{ uri, range: userRefRange }]);
  });

  it('filters same-name local variable references to the resolved function scope', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/ScopedLocals.hlsl';
    const text = [
      'float First() {',
      '  float i = 1;',
      '  i = i + 1;',
      '  return i;',
      '}',
      'float Second() {',
      '  float i = 2;',
      '  i = i + 1;',
      '  return i;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const firstLocal = index.symbols.find(
      (symbol) => symbol.name === 'i' && symbol.kind === 'localVariable' && symbol.scope === 'First',
    );
    if (!firstLocal?.scopeRange) throw new Error('missing First.i scope range');

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 2, character: 2 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual(expectedScopedLocations(index, 'i', firstLocal.scopeRange));
  });

  it('filters same-name parameter references to the resolved function scope', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/ScopedParameters.hlsl';
    const text = [
      'float2 TransformA(float2 uv) {',
      '  float2 shifted = uv;',
      '  return uv + shifted;',
      '}',
      'float2 TransformB(float2 uv) {',
      '  return uv;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const firstParameter = index.symbols.find(
      (symbol) => symbol.name === 'uv' && symbol.kind === 'parameter' && symbol.scope === 'TransformA',
    );
    if (!firstParameter?.scopeRange) throw new Error('missing TransformA.uv scope range');

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 1, character: 20 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual(expectedScopedLocations(index, 'uv', firstParameter.scopeRange));
  });

  it('filters parameter references from the parameter declaration position', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/ScopedParameterDeclaration.hlsl';
    const text = [
      'float2 TransformA(float2 uv) {',
      '  return uv;',
      '}',
      'float2 TransformB(float2 uv) {',
      '  return uv;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const firstParameter = index.symbols.find(
      (symbol) => symbol.name === 'uv' && symbol.kind === 'parameter' && symbol.scope === 'TransformA',
    );
    if (!firstParameter?.scopeRange) throw new Error('missing TransformA.uv scope range');

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 0, character: 25 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual(expectedScopedLocations(index, 'uv', firstParameter.scopeRange));
  });

  it('does not include member references that share a local variable name', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/ScopedMemberNoise.hlsl';
    const text = [
      'struct Surface { float i; };',
      'void Use(Surface s) {',
      '  float i = 0;',
      '  s.i = i;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const local = index.symbols.find(
      (symbol) => symbol.name === 'i' && symbol.kind === 'localVariable',
    );
    if (!local?.scopeRange) throw new Error('missing local i scope range');

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 2, character: 8 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual(expectedScopedLocations(index, 'i', local.scopeRange));
  });

  it('filters member references to the matching receiver type', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/MemberReferences.hlsl';
    const text = [
      'struct Surface { float3 positionWS; };',
      'struct Other { float3 positionWS; };',
      'float3 ReadSurface(Surface surface) {',
      '  return surface.positionWS;',
      '}',
      'float3 ReadOther(Other other) {',
      '  return other.positionWS;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const surfaceMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'Surface',
    );
    const surfaceReference = index.references.find(
      (reference) =>
        reference.name === 'positionWS' &&
        reference.context === 'member' &&
        reference.location.range.start.line === 3,
    );
    if (!surfaceMember || !surfaceReference) {
      throw new Error('missing Surface.positionWS fixture locations');
    }

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 3, character: 20 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([
      { uri, range: surfaceMember.location.range },
      { uri, range: surfaceReference.location.range },
    ]);
  });

  it('filters complex member receiver references to the matching receiver type', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Issue9MemberReferences.hlsl';
    const text = [
      'struct Light { float3 color; };',
      'struct Other { float3 color; };',
      'float3 ReadLight(Light lights[4], int i) {',
      '  return lights[i].color;',
      '}',
      'float3 ReadOther(Other other) {',
      '  return other.color;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const lightMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'color' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'Light',
    );
    const lightReference = index.references.find(
      (reference) =>
        reference.name === 'color' &&
        reference.context === 'member' &&
        reference.location.range.start.line === 3,
    );
    if (!lightMember || !lightReference) {
      throw new Error('missing Light.color fixture locations');
    }

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 3, character: 20 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([
      { uri, range: lightMember.location.range },
      { uri, range: lightReference.location.range },
    ]);
  });

  it('filters member references from a struct member declaration position', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/MemberDeclarationReferences.hlsl';
    const text = [
      'struct Surface { float3 positionWS; };',
      'struct Other { float3 positionWS; };',
      'float3 ReadSurface(Surface surface) {',
      '  return surface.positionWS;',
      '}',
      'float3 ReadOther(Other other) {',
      '  return other.positionWS;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const surfaceMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'Surface',
    );
    const surfaceReference = index.references.find(
      (reference) =>
        reference.name === 'positionWS' &&
        reference.context === 'member' &&
        reference.location.range.start.line === 3,
    );
    if (!surfaceMember || !surfaceReference) {
      throw new Error('missing Surface.positionWS fixture locations');
    }

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 0, character: 25 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([
      { uri, range: surfaceMember.location.range },
      { uri, range: surfaceReference.location.range },
    ]);
  });

  it('filters global function references by kind when a local variable shares the name', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/GlobalFunctionKind.hlsl';
    const text = [
      'float Helper(float x) { return x; }',
      'float Main() {',
      '  return Helper(1);',
      '}',
      'float Noise() {',
      '  float Helper = 0;',
      '  Helper = Helper + 1;',
      '  return Helper;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const functionSymbol = index.symbols.find(
      (symbol) => symbol.name === 'Helper' && symbol.kind === 'function',
    );
    const functionCall = index.references.find(
      (reference) =>
        reference.name === 'Helper' &&
        reference.context === 'call' &&
        reference.location.range.start.line === 2,
    );
    if (!functionSymbol || !functionCall) {
      throw new Error('missing Helper function fixture locations');
    }

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 2, character: 11 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([
      { uri, range: functionSymbol.location.range },
      { uri, range: functionCall.location.range },
    ]);
  });

  it('filters global call references to call-compatible targets when a struct shares the name', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/GlobalFunctionStructKind.hlsl';
    const text = [
      'struct Helper { float value; };',
      'float Helper(float x) { return x; }',
      'float UseFunction() {',
      '  return Helper(1);',
      '}',
      'float UseType(Helper value) {',
      '  return value.value;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const functionSymbol = index.symbols.find(
      (symbol) => symbol.name === 'Helper' && symbol.kind === 'function',
    );
    const functionCall = index.references.find(
      (reference) =>
        reference.name === 'Helper' &&
        reference.context === 'call' &&
        reference.location.range.start.line === 3,
    );
    const typeReference = index.references.find(
      (reference) => reference.name === 'Helper' && reference.context === 'type',
    );
    if (!functionSymbol || !functionCall || !typeReference) {
      throw new Error('missing Helper function/struct fixture locations');
    }

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 3, character: 11 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([
      { uri, range: functionSymbol.location.range },
      { uri, range: functionCall.location.range },
    ]);
  });

  it('keeps macro references broad enough for define symbols while excluding local noise', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/MacroReferences.hlsl';
    const text = [
      '#define SAMPLE_TEXTURE2D(tex, sampler, uv) tex.Sample(sampler, uv)',
      'float4 Use(float2 uv) {',
      '  return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);',
      '}',
      'float Noise() {',
      '  float SAMPLE_TEXTURE2D = 0;',
      '  SAMPLE_TEXTURE2D = SAMPLE_TEXTURE2D + 1;',
      '  return SAMPLE_TEXTURE2D;',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
      packages: { isInPackages: () => false },
    };
    workspace.index.global.upsert(index);
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const macroSymbol = index.symbols.find(
      (symbol) => symbol.name === 'SAMPLE_TEXTURE2D' && symbol.kind === 'macro',
    );
    const macroCall = index.references.find(
      (reference) =>
        reference.name === 'SAMPLE_TEXTURE2D' &&
        reference.context === 'call' &&
        reference.location.range.start.line === 2,
    );
    if (!macroSymbol || !macroCall) {
      throw new Error('missing SAMPLE_TEXTURE2D fixture locations');
    }

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 2, character: 12 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([
      { uri, range: macroSymbol.location.range },
      { uri, range: macroCall.location.range },
    ]);
  });

  it('returns include references that resolve to the same file across path spellings', async () => {
    const { connection, handler } = captureReferencesHandler();
    const filePath = join(includeFixtureRoot, 'Assets/Shaders/IncludeRefs.hlsl');
    const uri = pathToFileURL(filePath).href;
    const text = [
      '#include "Common.hlsl"',
      '#include "../Shaders/Common.hlsl"',
      '#include "Packages/com.example.assets/Shaders/Common.hlsl"',
      '#include "Inner/Lighting.hlsl"',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const workspace = {
      settings: DEFAULT_SETTINGS,
      packages: {
        includeCtx: {
          unityProjectRoot: includeFixtureRoot,
          includeDirectories: [],
          packagePhysicalPaths: new Map([['com.example.assets', join(includeFixtureRoot, 'Assets')]]),
        },
        isInPackages: () => false,
      },
      index: {
        store,
        global: new GlobalSymbolIndex(),
        globalRefs: new GlobalReferenceIndex(),
      },
    };
    workspace.index.globalRefs.upsert(index);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;

    registerReferencesHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 0, character: 12 },
      context: { includeDeclaration: false },
    });

    expect(result).toEqual([
      { uri, range: index.references[0].location.range },
      { uri, range: index.references[1].location.range },
      { uri, range: index.references[2].location.range },
    ]);
  });

  it('waits for RequestSuspender release before resolving references', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Use.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, 'float4 main() { return 0; }');
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return {
          settings: DEFAULT_SETTINGS,
          index: {
            global: new GlobalSymbolIndex(),
            globalRefs: new GlobalReferenceIndex(),
          },
          packages: { isInPackages: () => false },
        };
      },
    } as never;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();

    registerReferencesHandler(connection, documents, manager, suspender);

    const promise = handler()({
      textDocument: { uri },
      position: { line: 0, character: 7 },
      context: { includeDeclaration: false },
    });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(settled).toBe(false);
    suspender.release();
    await expect(promise).resolves.toEqual([]);
  });
});
