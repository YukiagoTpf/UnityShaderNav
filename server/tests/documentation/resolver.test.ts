import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, type SymbolEntry } from '@unity-shader-nav/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DocumentationResolver,
  type DocumentationResolution,
  type DocumentationResolutionRequest,
} from '../../src/documentation';
import { PackageContext } from '../../src/packages';
import { scanBlocks } from '../../src/parser/shaderlab/blockScanner';
import { scanShaderLabTokens } from '../../src/parser/shaderlab/tokenScanner';
import { UnityProjectFacts } from '../../src/project';

const roots: string[] = [];
const packageName = 'com.unity.render-pipelines.universal';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface PackageFixtureOptions {
  readonly version?: string;
  readonly source?: 'registry' | 'local' | 'git';
  readonly scopedRegistries?: readonly string[];
  readonly includeManifest?: boolean;
}

async function context(options: PackageFixtureOptions = {}): Promise<{
  packages: PackageContext;
  packageUri: string;
}> {
  const {
    version = '17.0.3',
    source = 'registry',
    scopedRegistries = [],
    includeManifest = true,
  } = options;
  const root = await mkdtemp(join(tmpdir(), 'usn-docs-'));
  roots.push(root);
  const hash = '1234567890abcdef';
  const packageRoot = source === 'local'
    ? join(root, 'External', packageName)
    : join(root, 'Library', 'PackageCache', `${packageName}@${source === 'git' ? hash.slice(0, 10) : 'hash'}`);
  const lockEntry = source === 'local'
    ? { version: `file:../External/${packageName}`, source }
    : source === 'git'
      ? { version: 'https://example.test/fork.git', source, hash }
      : { version, source, hash: 'hash' };
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
    dependencies: { [packageName]: lockEntry },
  }));
  await writeFile(join(root, 'Packages', 'manifest.json'), JSON.stringify({
    dependencies: { [packageName]: version },
    scopedRegistries: scopedRegistries.length > 0
      ? [{ name: 'custom', url: 'https://registry.example.test', scopes: scopedRegistries }]
      : [],
  }));
  if (includeManifest) {
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: packageName,
      version,
    }));
  }
  const packages = await PackageContext.load(root, DEFAULT_SETTINGS);
  return {
    packages,
    packageUri: pathToFileURL(join(packageRoot, 'ShaderLibrary', 'Core.hlsl')).href,
  };
}

describe('DocumentationResolver', () => {
  it('interprets every Documentation target role through one Interface', () => {
    const resolver = new DocumentationResolver(
      PackageContext.standalone(DEFAULT_SETTINGS),
      UnityProjectFacts.fromProjectVersionText('m_EditorVersion: 2022.3.53f1\n'),
    );
    const shaderText = [
      'Shader "Docs/Test" {',
      '  Properties { [HDR] _MainTex ("Texture", 2D) = "white" {} }',
      '  SubShader { Cull Back Pass {',
      '    HLSLPROGRAM',
      '    float4 frag() : SV_Target { return 1; }',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');

    for (const [needle, expectedName] of [
      ['Cull', 'Cull'],
      ['HDR', 'HDR'],
      ['2D)', '2D'],
      ['SV_Target', 'SV_Target'],
    ] as const) {
      expect(candidateNames(resolver.resolve(requestAt(shaderText, needle, 'shaderlab'))))
        .toContain(expectedName);
    }
    expect(candidateNames(resolver.resolve(requestAt(
      'float4 Main(float3 value) { return normalize(value); }',
      'normalize',
      'hlsl',
    )))).toContain('normalize');
    expect(resolver.resolve(requestAt(shaderText, 'Back', 'shaderlab'))).toBeUndefined();
  });

  it('prefers matching declarations and carries exact visible Package provenance', async () => {
    const projectResolver = new DocumentationResolver(
      PackageContext.standalone(DEFAULT_SETTINGS),
      UnityProjectFacts.unknown(),
    );
    const projectSymbol = declaration(
      'GetVertexPositionInputs',
      'file:///project/Assets/Custom.hlsl',
    );
    expect(projectResolver.resolve(requestAt(
      'GetVertexPositionInputs(0);',
      'GetVertexPositionInputs',
      'hlsl',
      [projectSymbol],
    ))?.candidates).toEqual([
      { source: 'project', symbol: projectSymbol, package: undefined },
    ]);

    const local = await context({ source: 'local' });
    const localSymbol = declaration('GetVertexPositionInputs', local.packageUri);
    const localResolver = new DocumentationResolver(local.packages, UnityProjectFacts.unknown());
    expect(localResolver.resolve(requestAt(
      'GetVertexPositionInputs(0);',
      'GetVertexPositionInputs',
      'hlsl',
      [localSymbol],
      new Set([local.packageUri]),
    ))?.candidates).toEqual([
      {
        source: 'project',
        symbol: localSymbol,
        package: { name: packageName, version: undefined, source: 'local' },
      },
    ]);
    expect(localResolver.resolve(requestAt(
      'GetVertexPositionInputs(0);',
      'GetVertexPositionInputs',
      'hlsl',
      [localSymbol],
    ))).toBeUndefined();
  });

  it('accepts compatible visible fallback and carries captured Package facts', async () => {
    const { packages, packageUri } = await context();
    const resolver = new DocumentationResolver(packages, UnityProjectFacts.unknown());
    const resolution = resolver.resolve(requestAt(
      'GetVertexPositionInputs(0);',
      'GetVertexPositionInputs',
      'hlsl',
      [],
      new Set([packageUri]),
    ));

    expect(resolution?.candidates).toEqual([
      expect.objectContaining({
        source: 'builtin',
        package: {
          name: packageName,
          version: '17.0.3',
          source: 'registry',
        },
      }),
    ]);
  });

  it('stays neutral for unknown, invisible, incompatible, local, forked, and custom facts', async () => {
    const compatible = await context();
    const unknown = await context({ version: 'unknown-version', includeManifest: false });
    const incompatible = await context({ version: '16.0.6' });
    const local = await context({ source: 'local' });
    const forked = await context({ source: 'git' });
    const customRegistry = await context({ scopedRegistries: ['com.unity'] });
    const cases = [
      { context: compatible, visible: new Set<string>() },
      { context: unknown, visible: new Set([unknown.packageUri]) },
      { context: incompatible, visible: new Set([incompatible.packageUri]) },
      { context: local, visible: new Set([local.packageUri]) },
      { context: forked, visible: new Set([forked.packageUri]) },
      { context: customRegistry, visible: new Set([customRegistry.packageUri]) },
    ];

    for (const entry of cases) {
      const resolver = new DocumentationResolver(
        entry.context.packages,
        UnityProjectFacts.unknown(),
      );
      expect(resolver.resolve(requestAt(
        'GetVertexPositionInputs(0);',
        'GetVertexPositionInputs',
        'hlsl',
        [],
        entry.visible,
      ))).toBeUndefined();
    }
  });

  it('gates Unity fallback by the captured editor major/minor version', () => {
    const packages = PackageContext.standalone(DEFAULT_SETTINGS);
    const request = requestAt('Shader "X" { SubShader { Cull Back } }', 'Cull', 'shaderlab');
    const supported = UnityProjectFacts.fromProjectVersionText(
      'm_EditorVersion: 2022.3.53f1\n',
    );
    const incompatible = UnityProjectFacts.fromProjectVersionText(
      'm_EditorVersion: 2021.3.45f1\n',
    );

    expect(new DocumentationResolver(packages, supported).resolve(request)).toBeDefined();
    expect(new DocumentationResolver(packages, incompatible).resolve(request)).toBeUndefined();
    expect(new DocumentationResolver(packages, UnityProjectFacts.unknown()).resolve(request))
      .toBeUndefined();
  });
});

function requestAt(
  text: string,
  needle: string,
  languageId: string,
  declarations: readonly SymbolEntry[] = [],
  visibleUriKeys: ReadonlySet<string> = new Set(),
): DocumentationResolutionRequest {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`missing ${needle}`);
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return {
    text,
    position: { line: lines.length - 1, character: lines.at(-1)!.length },
    languageId,
    uri: `file:///project/Assets/Docs.${languageId === 'hlsl' ? 'hlsl' : 'shader'}`,
    lexicalTokens: languageId === 'shaderlab'
      ? scanShaderLabTokens(text, scanBlocks(text).blocks)
      : undefined,
    declarations,
    visibleUriKeys,
  };
}

function declaration(name: string, uri: string): SymbolEntry {
  return {
    name,
    kind: 'function',
    location: {
      uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: name.length },
      },
    },
    returnType: 'float4',
    parameters: [],
  };
}

function candidateNames(resolution: DocumentationResolution | undefined): string[] {
  return resolution?.candidates.map((candidate) => (
    candidate.source === 'project' ? candidate.symbol.name : candidate.entry.name
  )) ?? [];
}
