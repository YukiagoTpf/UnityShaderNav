import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import type { DocumentSymbol, SemanticTokens } from 'vscode-languageserver/node';
import { describe, expect, it } from 'vitest';
import {
  analyzeDocument,
  type DocumentAnalysisDemand,
} from '../../src/analysis';
import { chooseCacheDir } from '../../src/cache/cacheManager';
import { indexFile } from '../../src/parser/hlsl';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { SEMANTIC_TOKEN_TYPES } from '../../src/workspace/semanticTokenLegend';
import { Workspace } from '../../src/workspace/workspace';

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

interface AnalysisCall {
  readonly uri: string;
  readonly text: string;
  readonly demand: DocumentAnalysisDemand;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(
  uri: string,
  text: string,
  version: number,
  openId = 1,
): IndexedDocumentSnapshot {
  return { uri, text, version, openId, languageId: 'shaderlab' };
}

function semanticTokenTexts(text: string, tokens: SemanticTokens): Array<{
  text: string;
  type: string;
}> {
  const lines = text.split(/\r?\n/);
  const result: Array<{ text: string; type: string }> = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    line += tokens.data[index];
    character = tokens.data[index] === 0
      ? character + tokens.data[index + 1]
      : tokens.data[index + 1];
    const length = tokens.data[index + 2];
    result.push({
      text: lines[line].slice(character, character + length),
      type: SEMANTIC_TOKEN_TYPES[tokens.data[index + 3]],
    });
  }
  return result;
}

function shaderSource(
  property: string,
  functionName: string,
  passName = functionName.replace(/Function$/, 'Pass'),
): string {
  return [
    'Shader "Tests/LiveAnalysis" {',
    '  Properties {',
    `    ${property} ("Value", Float) = 0`,
    '  }',
    '  SubShader {',
    '    Pass {',
    `      Name "${passName}"`,
    '      HLSLPROGRAM',
    `      float4 ${functionName}() : SV_Target { return 0; }`,
    '      ENDHLSL',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function documentSymbolNames(symbols: readonly DocumentSymbol[] | null): string[] {
  if (!symbols) return [];
  return symbols.flatMap((symbol) => [
    symbol.name,
    ...documentSymbolNames(symbol.children ?? []),
  ]);
}

describe('Workspace-owned Document analysis', () => {
  it('reuses one exact live analysis and replaces it only with a newer attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-document-analysis-'));
    const uri = pathToFileURL(join(root, 'Live.shader')).href;
    const firstText = shaderSource('_OldTint', 'OldFunction');
    const replacementText = shaderSource('_ReplacementTexture', 'ReplacementFunction');
    const calls: AnalysisCall[] = [];
    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
      releaseVersion: null,
      indexDocument: indexFile,
      analyzeDocument(analysisUri, text, demand) {
        calls.push({ uri: analysisUri, text, demand });
        return analyzeDocument(analysisUri, text, demand);
      },
    });

    try {
      await workspace.initialize(connection);
      expect(calls).toEqual([]);

      const first = snapshot(uri, firstText, 1);
      await expect(workspace.updateDocument(first)).resolves.toBe(true);
      expect(calls).toEqual([{ uri, text: firstText, demand: 'full' }]);
      expect(workspace.workspaceSymbols('OldFunction')).toHaveLength(1);
      expect(documentSymbolNames(await workspace.documentSymbols({ uri, document: first })))
        .toContain('Pass "OldPass"');

      const firstTokens = await workspace.semanticTokens({ uri, document: first });
      const repeatedTokens = await workspace.semanticTokens({ uri, document: first });
      expect(repeatedTokens.data).toEqual(firstTokens.data);
      expect(calls).toHaveLength(1);
      expect(semanticTokenTexts(firstText, firstTokens)).toEqual(expect.arrayContaining([
        { text: '_OldTint', type: 'property' },
        { text: 'OldFunction', type: 'function' },
      ]));

      await expect(workspace.reconfigure(connection, {
        ...DEFAULT_SETTINGS,
        debug: { definitionTrace: !DEFAULT_SETTINGS.debug.definitionTrace },
      })).resolves.toBe(false);
      const forkTokens = semanticTokenTexts(
        firstText,
        await workspace.semanticTokens({ uri, document: first }),
      );
      expect(forkTokens).toEqual(expect.arrayContaining([
        { text: 'Shader', type: 'keyword' },
        { text: '_OldTint', type: 'property' },
      ]));
      expect(calls).toHaveLength(1);

      await workspace.rebuild(connection);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual({ uri, text: firstText, demand: 'full' });
      const rebuiltTokens = semanticTokenTexts(
        firstText,
        await workspace.semanticTokens({ uri, document: first }),
      );
      expect(rebuiltTokens).toEqual(expect.arrayContaining([
        { text: 'Shader', type: 'keyword' },
        { text: '_OldTint', type: 'property' },
      ]));
      expect(calls).toHaveLength(2);

      const versionOnly = snapshot(uri, firstText, 2);
      await expect(workspace.updateDocument(versionOnly)).resolves.toBe(true);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual({ uri, text: firstText, demand: 'full' });
      await workspace.semanticTokens({ uri, document: versionOnly });
      expect(calls).toHaveLength(3);

      const replacement = snapshot(uri, replacementText, 3);
      await expect(workspace.updateDocument(replacement)).resolves.toBe(true);
      expect(calls).toHaveLength(4);
      expect(calls[3]).toEqual({ uri, text: replacementText, demand: 'full' });
      expect(workspace.workspaceSymbols('OldFunction')).toEqual([]);
      expect(workspace.workspaceSymbols('ReplacementFunction')).toHaveLength(1);
      const replacementOutline = documentSymbolNames(
        await workspace.documentSymbols({ uri, document: replacement }),
      );
      expect(replacementOutline).toContain('Pass "ReplacementPass"');
      expect(replacementOutline).not.toContain('Pass "OldPass"');

      const replacementTokens = await workspace.semanticTokens({ uri, document: replacement });
      const renderedReplacement = semanticTokenTexts(replacementText, replacementTokens);
      expect(renderedReplacement).toEqual(expect.arrayContaining([
        { text: '_ReplacementTexture', type: 'property' },
        { text: 'ReplacementFunction', type: 'function' },
      ]));
      expect(renderedReplacement).not.toContainEqual({
        text: '_OldTint',
        type: 'property',
      });
      expect(calls).toHaveLength(4);

      const forgedSameAttempt = snapshot(uri, firstText, 3);
      await expect(workspace.documentSymbols({ uri, document: forgedSameAttempt }))
        .resolves.toBeNull();

      await expect(workspace.updateDocument(versionOnly)).resolves.toBe(false);
      await expect(workspace.semanticTokens({ uri, document: versionOnly }))
        .resolves.toEqual({ data: [] });
      expect(calls).toHaveLength(4);

      await workspace.closeDocument({ uri, openId: 1 });
      expect(workspace.workspaceSymbols('ReplacementFunction')).toEqual([]);
      await expect(workspace.updateDocument(replacement)).resolves.toBe(false);
      await expect(workspace.semanticTokens({ uri, document: replacement }))
        .resolves.toEqual({ data: [] });
      expect(calls).toHaveLength(4);

      const reopenedText = shaderSource('_ReopenedTint', 'ReopenedFunction');
      const reopened = snapshot(uri, reopenedText, 1, 2);
      await expect(workspace.updateDocument(reopened)).resolves.toBe(true);
      const reopenedOutline = documentSymbolNames(
        await workspace.documentSymbols({ uri, document: reopened }),
      );
      expect(reopenedOutline).toContain('Pass "ReopenedPass"');
      expect(reopenedOutline).not.toContain('Pass "ReplacementPass"');
      expect(calls).toHaveLength(5);
    } finally {
      workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never publishes analysis prepared by a superseded asynchronous attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-document-analysis-race-'));
    const uri = pathToFileURL(join(root, 'Race.shader')).href;
    const staleText = shaderSource('_StaleTint', 'StaleFunction');
    const freshText = shaderSource('_FreshTint', 'FreshFunction');
    const staleStarted = deferred();
    const releaseStale = deferred();
    const calls: AnalysisCall[] = [];
    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
      releaseVersion: null,
      analyzeDocument(analysisUri, text, demand) {
        calls.push({ uri: analysisUri, text, demand });
        return analyzeDocument(analysisUri, text, demand);
      },
      async indexDocument(indexUri, text, table, analysis) {
        if (text === staleText) {
          staleStarted.resolve();
          await releaseStale.promise;
        }
        return indexFile(indexUri, text, table, analysis);
      },
    });

    try {
      await workspace.initialize(connection);
      const initialRevision = workspace.indexStatus().lifecycle.revision;
      const stale = snapshot(uri, staleText, 1);
      const fresh = snapshot(uri, freshText, 2);
      const staleUpdate = workspace.updateDocument(stale);
      await staleStarted.promise;
      const freshUpdate = workspace.updateDocument(fresh);
      releaseStale.resolve();

      await expect(staleUpdate).resolves.toBe(false);
      await expect(freshUpdate).resolves.toBe(true);
      expect(workspace.indexStatus().lifecycle.revision).toBe(initialRevision + 1);
      expect(calls).toEqual([
        { uri, text: staleText, demand: 'full' },
        { uri, text: freshText, demand: 'full' },
      ]);
      expect(workspace.workspaceSymbols('StaleFunction')).toEqual([]);
      expect(workspace.workspaceSymbols('FreshFunction')).toHaveLength(1);
      const freshOutline = documentSymbolNames(
        await workspace.documentSymbols({ uri, document: fresh }),
      );
      expect(freshOutline).toContain('Pass "FreshPass"');
      expect(freshOutline).not.toContain('Pass "StalePass"');
      await expect(workspace.semanticTokens({ uri, document: stale }))
        .resolves.toEqual({ data: [] });

      const freshTokens = semanticTokenTexts(
        freshText,
        await workspace.semanticTokens({ uri, document: fresh }),
      );
      expect(freshTokens).toContainEqual({ text: '_FreshTint', type: 'property' });
      expect(freshTokens).not.toContainEqual({ text: '_StaleTint', type: 'property' });
      expect(calls).toHaveLength(2);
    } finally {
      releaseStale.resolve();
      workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists only disk FileIndex data and never serializes live analysis', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'usn-document-analysis-cache-'));
    const root = join(temp, 'workspace');
    const globalStorage = join(temp, 'global-storage');
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Cached.shader');
    const uri = pathToFileURL(sourcePath).href;
    const diskText = shaderSource('_DiskTint', 'DiskFunction', 'DiskPass');
    const liveText = shaderSource('_LiveTint', 'LiveFunction', 'LivePass');
    await writeFile(sourcePath, diskText);

    const folderUri = pathToFileURL(root).href;
    const calls: AnalysisCall[] = [];
    const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, {
      releaseVersion: '0.1.1',
      indexDocument: indexFile,
      analyzeDocument(analysisUri, sourceText, demand) {
        calls.push({ uri: analysisUri, text: sourceText, demand });
        return analyzeDocument(analysisUri, sourceText, demand);
      },
    });

    try {
      await workspace.initialize(connection, globalStorage);
      expect(calls).toEqual([{ uri, text: diskText, demand: 'index' }]);
      await workspace.updateDocument(snapshot(uri, liveText, 1));
      expect(calls).toEqual([
        { uri, text: diskText, demand: 'index' },
        { uri, text: liveText, demand: 'full' },
      ]);

      const openDocument = snapshot(uri, liveText, 1);
      const openTokens = semanticTokenTexts(
        liveText,
        await workspace.semanticTokens({ uri, document: openDocument }),
      );
      expect(openTokens).toContainEqual({ text: 'Shader', type: 'keyword' });
      expect(documentSymbolNames(
        await workspace.documentSymbols({ uri, document: openDocument }),
      )).toContain('Pass "LivePass"');

      await workspace.closeDocument({ uri, openId: openDocument.openId });
      const diskTokens = semanticTokenTexts(
        diskText,
        await workspace.semanticTokens({ uri }),
      );
      expect(diskTokens).toContainEqual({ text: 'DiskFunction', type: 'function' });
      expect(diskTokens).not.toContainEqual({ text: 'Shader', type: 'keyword' });
      expect(diskTokens).not.toContainEqual({ text: '_DiskTint', type: 'property' });
      const closedOutline = documentSymbolNames(await workspace.documentSymbols({ uri }));
      expect(closedOutline).toContain('Pass "DiskPass"');
      expect(closedOutline).not.toContain('Pass "LivePass"');
      expect(calls).toHaveLength(2);

      await workspace.persist();

      const cacheDir = chooseCacheDir({
        unityProjectRoot: root,
        workspaceFolderUri: pathToFileURL(root).href,
        globalStorageDir: undefined,
      });
      if (!cacheDir) throw new Error('Expected a Unity workspace cache directory');
      const cachePath = join(cacheDir, 'index.json');
      const manifestText = await readFile(cachePath, 'utf8');
      const manifest = JSON.parse(manifestText) as {
        files: Array<{
          index: {
            symbols: Array<{ name: string }>;
            structure?: {
              shaders: Array<{
                children: Array<{
                  kind: string;
                  children: Array<{ kind: string; name?: string }>;
                }>;
              }>;
            };
          };
        }>;
      };

      expect(manifest.files).toHaveLength(1);
      expect(manifest.files[0].index.symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'DiskFunction' }),
      ]));
      const persistedSubshader = manifest.files[0].index.structure?.shaders[0].children
        .find((child) => child.kind === 'subshader');
      expect(persistedSubshader?.children.find((child) => child.kind === 'pass')?.name)
        .toBe('DiskPass');
      expect(manifestText).not.toContain('LivePass');
      expect(manifestText).not.toContain('"analysis"');
      expect(manifestText).not.toContain('"sourceText"');
      expect(manifestText).not.toContain('"lexicalTokens"');

      workspace.dispose();
      const warmCalls: AnalysisCall[] = [];
      const warmWorkspace = new Workspace(folderUri, DEFAULT_SETTINGS, {
        releaseVersion: '0.1.1',
        indexDocument: indexFile,
        analyzeDocument(analysisUri, sourceText, demand) {
          warmCalls.push({ uri: analysisUri, text: sourceText, demand });
          return analyzeDocument(analysisUri, sourceText, demand);
        },
      });
      try {
        await warmWorkspace.initialize(connection, globalStorage);
        expect(warmCalls).toEqual([]);
        expect(documentSymbolNames(await warmWorkspace.documentSymbols({ uri })))
          .toContain('Pass "DiskPass"');
      } finally {
        warmWorkspace.dispose();
      }
    } finally {
      workspace.dispose();
      await rm(temp, { recursive: true, force: true });
    }
  });
});
