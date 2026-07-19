import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import type { LocationLink, SemanticTokens } from 'vscode-languageserver/node';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageContext } from '../../src/packages';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import {
  IndexedRevisionBuilder,
  type PublishedIndexedRevision,
} from '../../src/workspace/indexedRevision';
import { includePointContextStore } from '../../src/workspace/includePointContextStore';
import { SEMANTIC_TOKEN_TYPES } from '../../src/workspace/semanticTokenLegend';

const fakeConnection = {
  console: { log() {}, warn() {} },
} as never;

const SHADER_TEXT = [
  'Shader "Context/Shared" {',
  '  HLSLINCLUDE',
  '  #define SHARED_SEED',
  '  ENDHLSL',
  '  SubShader {',
  '    Pass {',
  '      Name "Forward"',
  '      HLSLPROGRAM',
  '      #pragma vertex VertForward',
  '      #pragma fragment FragForward',
  '      #define FORWARD_PASS',
  '      #include "Nested.hlsl"',
  '      ENDHLSL',
  '    }',
  '    Pass {',
  '      Name "Unlit"',
  '      HLSLPROGRAM',
  '      #pragma fragment FragUnlit',
  '      #undef FORWARD_PASS',
  '      #include "Shared.hlsl"',
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
].join('\n');

const NESTED_TEXT = [
  '#define NESTED_PATH',
  '#include "Shared.hlsl"',
].join('\n');

const SHARED_TEXT = [
  '#ifdef FORWARD_PASS',
  'float4 BranchValue() { return 1; }',
  '#pragma vertex MissingForward',
  '#else',
  'float BranchValue() { return 0; }',
  '#endif',
  '#ifdef NESTED_PATH',
  'float NestedValue;',
  '#endif',
  'void Use() { BranchValue(); }',
  'Bra',
].join('\n');

interface Fixture {
  readonly root: string;
  readonly folderUri: string;
  readonly shaderPath: string;
  readonly shaderUri: string;
  readonly nestedPath: string;
  readonly nestedUri: string;
  readonly sharedPath: string;
  readonly sharedUri: string;
  readonly revision: PublishedIndexedRevision;
}

afterEach(() => {
  includePointContextStore.clear();
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'usn-include-context-'));
  const shaderPath = join(root, 'Context.shader');
  const nestedPath = join(root, 'Nested.hlsl');
  const sharedPath = join(root, 'Shared.hlsl');
  await Promise.all([
    writeSource(shaderPath, SHADER_TEXT),
    writeSource(nestedPath, NESTED_TEXT),
    writeSource(sharedPath, SHARED_TEXT),
  ]);
  const folderUri = pathToFileURL(root).href;
  const builder = IndexedRevisionBuilder.create({
    folderUri,
    settings: DEFAULT_SETTINGS,
    unityRoot: undefined,
    packages: PackageContext.standalone(DEFAULT_SETTINGS),
    cache: undefined,
    fingerprint: undefined,
  });
  for (const path of [shaderPath, nestedPath, sharedPath]) {
    await builder.indexAndStore(path, fakeConnection);
  }
  return {
    root,
    folderUri,
    shaderPath,
    shaderUri: pathToFileURL(shaderPath).href,
    nestedPath,
    nestedUri: pathToFileURL(nestedPath).href,
    sharedPath,
    sharedUri: pathToFileURL(sharedPath).href,
    revision: builder.publish(1),
  };
}

async function writeSource(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function select(
  test: Fixture,
  contextId: string,
  publicationId = test.revision.publicationId,
): void {
  includePointContextStore.set(test.folderUri, { publicationId, contextId });
}

function document(test: Fixture): IndexedDocumentSnapshot {
  return {
    uri: test.sharedUri,
    languageId: 'hlsl',
    text: SHARED_TEXT,
    openId: 1,
    version: 1,
  };
}

function positionOf(text: string, needle: string, occurrence = 0) {
  let offset = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(needle, from);
    if (offset < 0) throw new Error(`Missing ${needle}`);
    from = offset + needle.length;
  }
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length + 1 };
}

function functionTokenLines(tokens: SemanticTokens): number[] {
  const lines: number[] = [];
  let line = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    line += tokens.data[index];
    if (SEMANTIC_TOKEN_TYPES[tokens.data[index + 3]] === 'function') lines.push(line);
  }
  return lines;
}

describe('Published include-point Context Matrix', () => {
  it('derives multiple stages and nested include points with Shader/Pass/source identity', async () => {
    const test = await fixture();
    try {
      const result = await test.revision.knownIncludePointContexts(test.sharedUri);
      expect(result).toMatchObject({
        folderUri: test.folderUri,
        revision: 1,
        publicationId: test.revision.publicationId,
      });
      expect(result.contexts).toHaveLength(3);
      expect(result.contexts.map((context) => ({
        shader: context.shaderName,
        pass: context.passName,
        stage: context.stage,
        entry: context.entryPoint,
        source: context.includeLocation.uri,
        line: context.includeLocation.range.start.line,
        depth: context.chainDepth,
      }))).toEqual([
        {
          shader: 'Context/Shared',
          pass: 'Forward',
          stage: 'fragment',
          entry: 'FragForward',
          source: test.nestedUri,
          line: 1,
          depth: 2,
        },
        {
          shader: 'Context/Shared',
          pass: 'Forward',
          stage: 'vertex',
          entry: 'VertForward',
          source: test.nestedUri,
          line: 1,
          depth: 2,
        },
        {
          shader: 'Context/Shared',
          pass: 'Unlit',
          stage: 'fragment',
          entry: 'FragUnlit',
          source: test.shaderUri,
          line: 19,
          depth: 1,
        },
      ]);

      const forward = result.contexts.find(({ entryPoint }) => entryPoint === 'FragForward')!;
      select(test, forward.id);
      const forwardState = await test.revision.preprocessorContext(test.sharedUri);
      expect(forwardState?.definedMacros).toEqual(new Set([
        'SHARED_SEED',
        'FORWARD_PASS',
        'NESTED_PATH',
      ]));

      const unlit = result.contexts.find(({ entryPoint }) => entryPoint === 'FragUnlit')!;
      select(test, unlit.id);
      const unlitState = await test.revision.preprocessorContext(test.sharedUri);
      expect(unlitState?.definedMacros).toEqual(new Set(['SHARED_SEED']));
      expect(unlitState?.undefinedMacros).toEqual(new Set(['FORWARD_PASS']));
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('uses deterministic defines for dimming, Semantic Tokens, Completion, and diagnostics', async () => {
    const test = await fixture();
    try {
      const contexts = (await test.revision.knownIncludePointContexts(test.sharedUri)).contexts;
      const forward = contexts.find(({ entryPoint }) => entryPoint === 'FragForward')!;
      const unlit = contexts.find(({ entryPoint }) => entryPoint === 'FragUnlit')!;

      select(test, forward.id);
      expect(await test.revision.inactiveRegions(test.sharedUri, SHARED_TEXT)).toContainEqual({
        range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } },
        reason: 'inactive',
      });
      expect(functionTokenLines(await test.revision.semanticTokens({
        uri: test.sharedUri,
        document: document(test),
      }))).not.toContain(4);
      expect((await test.revision.completionAt({
        document: document(test),
        position: { line: 10, character: 3 },
      }))?.find(({ label }) => label === 'BranchValue')?.detail).toBe('float4 BranchValue()');
      expect(await test.revision.diagnostics(document(test))).toHaveLength(1);

      select(test, unlit.id);
      expect(await test.revision.inactiveRegions(test.sharedUri, SHARED_TEXT)).toEqual(
        expect.arrayContaining([
          {
            range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
            reason: 'inactive',
          },
        ]),
      );
      expect(functionTokenLines(await test.revision.semanticTokens({
        uri: test.sharedUri,
        document: document(test),
      }))).not.toContain(1);
      expect((await test.revision.completionAt({
        document: document(test),
        position: { line: 10, character: 3 },
      }))?.find(({ label }) => label === 'BranchValue')?.detail).toBe('float BranchValue()');
      expect(await test.revision.diagnostics(document(test))).toEqual([]);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('aggregates Auto diagnostics across the bounded revision-owned Context set', async () => {
    const test = await fixture();
    try {
      const diagnostics = await test.revision.diagnostics(document(test));

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: 'unresolved-entry-point',
        source: 'UnityShaderNav',
        message: expect.stringContaining(
          'Affected in 2 of 3 analyzed Shader Contexts.',
        ),
        data: {
          kind: 'context-diagnostic-group',
          affectedContextCount: 2,
          analyzedContextCount: 3,
          knownContextCount: 3,
          unverifiedContextCount: 0,
          affectedContexts: [
            {
              context: expect.objectContaining({
                shader: {
                  status: 'verified',
                  value: { uri: test.shaderUri, name: 'Context/Shared' },
                },
                pass: {
                  status: 'verified',
                  value: {
                    subShaderIndex: 0,
                    passIndex: 0,
                    passName: 'Forward',
                  },
                },
                stage: {
                  status: 'verified',
                  value: { stage: 'fragment', entryPoint: 'FragForward' },
                },
                keywords: expect.objectContaining({
                  status: 'unverified',
                  reason: 'keyword-selection-not-enumerated',
                }),
                platform: {
                  status: 'unverified',
                  reason: 'adapter-evidence-unavailable',
                },
                graphicsApi: {
                  status: 'unverified',
                  reason: 'adapter-evidence-unavailable',
                },
              }),
              provenances: [{
                kind: 'static',
                source: 'UnityShaderNav',
                revision: 1,
                publicationId: test.revision.publicationId,
              }],
            },
            expect.objectContaining({
              context: expect.objectContaining({
                stage: {
                  status: 'verified',
                  value: { stage: 'vertex', entryPoint: 'VertForward' },
                },
              }),
            }),
          ],
        },
      });
      expect(diagnostics[0].relatedInformation).toHaveLength(2);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('ranks Definition candidates by Context without deleting conservative results', async () => {
    const test = await fixture();
    try {
      const contexts = (await test.revision.knownIncludePointContexts(test.sharedUri)).contexts;
      const forward = contexts.find(({ entryPoint }) => entryPoint === 'FragForward')!;
      const unlit = contexts.find(({ entryPoint }) => entryPoint === 'FragUnlit')!;
      const input = {
        document: document(test),
        position: positionOf(SHARED_TEXT, 'BranchValue', 2),
      };

      select(test, forward.id);
      const forwardLinks = await test.revision.definitionAt(input) as LocationLink[];
      expect(forwardLinks.map(({ targetSelectionRange }) => targetSelectionRange.start.line))
        .toEqual([1, 4]);

      select(test, unlit.id);
      const unlitLinks = await test.revision.definitionAt(input) as LocationLink[];
      expect(unlitLinks.map(({ targetSelectionRange }) => targetSelectionRange.start.line))
        .toEqual([4, 1]);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('falls back to Auto across rebuild and live-edit publications without retargeting', async () => {
    const test = await fixture();
    try {
      const initial = await test.revision.knownIncludePointContexts(test.sharedUri);
      const selected = initial.contexts.find(({ entryPoint }) => entryPoint === 'FragForward')!;
      select(test, selected.id);
      expect(await test.revision.preprocessorContext(test.sharedUri)).toBeDefined();

      const rebuilt = test.revision.fork().publish(2);
      expect(rebuilt.publicationId).not.toBe(test.revision.publicationId);
      expect(await rebuilt.preprocessorContext(test.sharedUri)).toBeUndefined();
      expect((await rebuilt.knownIncludePointContexts(test.sharedUri)).contexts)
        .toContainEqual(expect.objectContaining({ id: selected.id }));

      const editedText = SHADER_TEXT.replace('      #include "Nested.hlsl"\n', '');
      await writeFile(test.shaderPath, editedText);
      const candidate = rebuilt.fork();
      await candidate.applyChanges(
        [{ uri: test.shaderUri, type: 'changed' }],
        fakeConnection,
      );
      const edited = candidate.publish(3);
      expect((await edited.knownIncludePointContexts(test.sharedUri)).contexts)
        .toHaveLength(1);
      expect(await edited.preprocessorContext(test.sharedUri)).toBeUndefined();
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
