import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MacroPatternRecognizer } from '../../../src/macros';
import { indexFile } from '../../../src/parser/hlsl/fileIndexer';
import {
  createHlslParser,
  type ReusableHlslParser,
} from '../../../src/parser/hlsl/parser';
import { LiveDocumentTreeSession } from '../../../src/parser/hlsl/liveDocumentTreeSession';

describe('LiveDocumentTreeSession', () => {
  it.each([
    ['functions.hlsl', join(__dirname, 'fixtures/functions.hlsl')],
    ['nested-struct.hlsl', join(__dirname, 'fixtures/nested-struct.hlsl')],
    ['textures.hlsl', join(__dirname, '../../macros/fixtures/textures.hlsl')],
    ['multi-pass.shader', join(__dirname, '../shaderlab/fixtures/multi-pass.shader')],
    ['cg-legacy.shader', join(__dirname, '../shaderlab/fixtures/cg-legacy.shader')],
    [
      'hlslinclude-with-passes.shader',
      join(__dirname, '../shaderlab/fixtures/hlslinclude-with-passes.shader'),
    ],
  ])('matches a full parse after a local edit to fixture %s', async (name, path) => {
    const source = readFileSync(path, 'utf8');
    const edited = editFixture(source, name.endsWith('.shader'));
    const uri = `file:///fixtures/${name}`;
    const session = new LiveDocumentTreeSession();

    try {
      await session.indexFile(uri, source);
      const incremental = await session.indexFile(uri, edited);
      expect(incremental).toEqual(await indexFile(uri, edited));
    } finally {
      session.dispose();
    }
  });

  it('reparses one HLSL document from its previous tree without changing FileIndex output', async () => {
    const parser = await createHlslParser();
    const parse = vi.fn(parser.parseStabilized.bind(parser));
    const trackedParser: ReusableHlslParser = {
      parseStabilized: parse,
      delete: parser.delete.bind(parser),
    };
    const session = new LiveDocumentTreeSession(async () => trackedParser);
    const uri = 'file:///t/Incremental.hlsl';
    const recognizer = new MacroPatternRecognizer();
    const initial = [
      '#define SCALE 1',
      'float4 Initial(float4 value) { return value * SCALE; }',
    ].join('\n');
    const edited = [
      '#define SCALE 2',
      'float4 Edited(float4 value) { return value * SCALE; }',
    ].join('\n');

    try {
      await session.indexFile(uri, initial, recognizer);
      const incremental = await session.indexFile(uri, edited, recognizer);
      const full = await indexFile(uri, edited, recognizer);

      expect(parse).toHaveBeenCalledTimes(2);
      expect(parse.mock.calls[0][1]).toBeUndefined();
      expect(parse.mock.calls[1][1]).toBeDefined();
      expect(incremental).toEqual(full);
    } finally {
      session.dispose();
    }
  });

  it('edits the stabilized sources with UTF-16 indices and points', async () => {
    const parser = await createHlslParser();
    let edit: ReturnType<typeof vi.spyOn> | undefined;
    const trackedParser: ReusableHlslParser = {
      parseStabilized(text, oldTree) {
        const tree = parser.parseStabilized(text, oldTree);
        if (!oldTree) edit = vi.spyOn(tree, 'edit');
        return tree;
      },
      delete: parser.delete.bind(parser),
    };
    const session = new LiveDocumentTreeSession(async () => trackedParser);
    const uri = 'file:///t/Utf16.hlsl';
    const initial = [
      '// 😀',
      'UNITY_VERTEX_INPUT_INSTANCE_ID',
      'float4 Main() { return 0; }',
    ].join('\n');
    const edited = [
      '// 😀',
      'UNITY_VERTEX_INPUT_INSTANCE_ID;',
      'float4 Main() { return 0; }',
    ].join('\n');

    try {
      await session.indexFile(uri, initial);
      const incremental = await session.indexFile(uri, edited);
      const full = await indexFile(uri, edited);
      const changedCharacter = 'UNITY_VERTEX_INPUT_INSTANCE_I'.length;
      const changedIndex = '// 😀\n'.length + changedCharacter;

      expect(edit).toHaveBeenCalledWith({
        startIndex: changedIndex,
        oldEndIndex: changedIndex,
        newEndIndex: changedIndex + 1,
        startPosition: { row: 1, column: changedCharacter },
        oldEndPosition: { row: 1, column: changedCharacter },
        newEndPosition: { row: 1, column: changedCharacter + 1 },
      });
      expect(incremental).toEqual(full);
    } finally {
      session.dispose();
    }
  });

  it('retains an ordered tree forest for ShaderLab program blocks', async () => {
    const parser = await createHlslParser();
    const parse = vi.fn(parser.parseStabilized.bind(parser));
    const session = new LiveDocumentTreeSession(async () => ({
      parseStabilized: parse,
      delete: parser.delete.bind(parser),
    }));
    const uri = 'file:///t/Forest.shader';
    const initial = shaderWithBlocks('FirstBlock', 'SecondBlock');
    const edited = shaderWithBlocks('FirstBlock', 'EditedSecondBlock');

    try {
      await session.indexFile(uri, initial);
      const incremental = await session.indexFile(uri, edited);
      const full = await indexFile(uri, edited);

      expect(parse).toHaveBeenCalledTimes(3);
      expect(parse.mock.calls[0][1]).toBeUndefined();
      expect(parse.mock.calls[1][1]).toBeUndefined();
      expect(parse.mock.calls[2][1]).toBeDefined();
      expect(incremental).toEqual(full);
    } finally {
      session.dispose();
    }
  });

  it('keeps full-parse output when ShaderLab block insertion and deletion shift forest indices', async () => {
    const parser = await createHlslParser();
    const parse = vi.fn(parser.parseStabilized.bind(parser));
    const session = new LiveDocumentTreeSession(async () => ({
      parseStabilized: parse,
      delete: parser.delete.bind(parser),
    }));
    const uri = 'file:///t/ShiftedForest.shader';
    const initial = shaderWithProgramBlocks('FirstBlock', 'SecondBlock');
    const inserted = shaderWithProgramBlocks('InsertedBlock', 'FirstBlock', 'SecondBlock');
    const deleted = shaderWithProgramBlocks('FirstBlock', 'SecondBlock');

    try {
      await session.indexFile(uri, initial);
      const afterInsert = await session.indexFile(uri, inserted);
      const afterDelete = await session.indexFile(uri, deleted);

      expect(afterInsert).toEqual(await indexFile(uri, inserted));
      expect(afterDelete).toEqual(await indexFile(uri, deleted));
      expect(parse).toHaveBeenCalledTimes(7);
      expect(parse.mock.calls.slice(2, 5).map((call) => call[1] !== undefined)).toEqual([
        true,
        true,
        false,
      ]);
      expect(parse.mock.calls.slice(5).every((call) => call[1] !== undefined)).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('releases a parser whose creation finishes after the session was disposed', async () => {
    const parser = await createHlslParser();
    const releaseParser = vi.fn(parser.delete.bind(parser));
    const parserStarted = deferred<void>();
    const parserReady = deferred<ReusableHlslParser>();
    const session = new LiveDocumentTreeSession(async () => {
      parserStarted.resolve(undefined);
      return parserReady.promise;
    });

    const indexing = session.indexFile(
      'file:///t/DisposedDuringFactory.hlsl',
      'float4 NeverPublished() { return 0; }',
    );
    await parserStarted.promise;
    session.dispose();
    parserReady.resolve({
      parseStabilized: parser.parseStabilized.bind(parser),
      delete: releaseParser,
    });

    await expect(indexing).rejects.toThrow('session was disposed');
    expect(releaseParser).toHaveBeenCalledTimes(1);
  });

  it('releases active old and new trees exactly once when disposed between parse and collect', async () => {
    const parser = await createHlslParser();
    const treeDeletes: Array<ReturnType<typeof vi.fn>> = [];
    const parserDelete = vi.fn(parser.delete.bind(parser));
    let session!: LiveDocumentTreeSession;
    let parseCount = 0;
    session = new LiveDocumentTreeSession(async () => ({
      parseStabilized(text, oldTree) {
        const tree = parser.parseStabilized(text, oldTree);
        const originalDelete = tree.delete.bind(tree);
        let released = false;
        const deleteTree = vi.fn(() => {
          if (released) return;
          released = true;
          originalDelete();
        });
        tree.delete = deleteTree;
        treeDeletes.push(deleteTree);
        parseCount++;
        if (parseCount === 2) queueMicrotask(() => session.dispose());
        return tree;
      },
      delete: parserDelete,
    }));

    await session.indexFile(
      'file:///t/DisposeDuringCollect.hlsl',
      'float4 BeforeDispose() { return 0; }',
    );
    await expect(session.indexFile(
      'file:///t/DisposeDuringCollect.hlsl',
      'float4 AfterDispose() { return 0; }',
    )).rejects.toThrow('session was disposed');

    expect(treeDeletes).toHaveLength(2);
    expect(treeDeletes.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(parserDelete).toHaveBeenCalledTimes(1);
  });

  it('releases replaced and retained trees exactly once when the session closes', async () => {
    const parser = await createHlslParser();
    const treeDeletes: Array<ReturnType<typeof vi.fn>> = [];
    const parserDelete = vi.fn(parser.delete.bind(parser));
    const session = new LiveDocumentTreeSession(async () => ({
      parseStabilized(text, oldTree) {
        const tree = parser.parseStabilized(text, oldTree);
        const deleteTree = vi.fn(tree.delete.bind(tree));
        tree.delete = deleteTree;
        treeDeletes.push(deleteTree);
        return tree;
      },
      delete: parserDelete,
    }));

    await session.indexFile('file:///t/Release.hlsl', 'float4 First() { return 0; }');
    await session.indexFile('file:///t/Release.hlsl', 'float4 Second() { return 0; }');
    expect(treeDeletes[0]).toHaveBeenCalledTimes(1);
    expect(treeDeletes[1]).not.toHaveBeenCalled();

    session.dispose();
    session.dispose();

    expect(treeDeletes[0]).toHaveBeenCalledTimes(1);
    expect(treeDeletes[1]).toHaveBeenCalledTimes(1);
    expect(parserDelete).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent attempts through one per-session tree queue', async () => {
    const parser = await createHlslParser();
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => { releaseFactory = resolve; });
    const parse = vi.fn(parser.parseStabilized.bind(parser));
    const session = new LiveDocumentTreeSession(async () => {
      await factoryGate;
      return {
        parseStabilized: parse,
        delete: parser.delete.bind(parser),
      };
    });
    const uri = 'file:///t/Queued.hlsl';
    const firstText = 'float4 QueuedFirst() { return 0; }';
    const secondText = 'float4 QueuedSecond() { return 0; }';

    try {
      const first = session.indexFile(uri, firstText);
      const second = session.indexFile(uri, secondText);
      await Promise.resolve();
      expect(parse).not.toHaveBeenCalled();

      releaseFactory();
      const [firstIndex, secondIndex] = await Promise.all([first, second]);

      expect(firstIndex).toEqual(await indexFile(uri, firstText));
      expect(secondIndex).toEqual(await indexFile(uri, secondText));
      expect(parse).toHaveBeenCalledTimes(2);
      expect(parse.mock.calls[0][1]).toBeUndefined();
      expect(parse.mock.calls[1][1]).toBeDefined();
    } finally {
      releaseFactory();
      session.dispose();
    }
  });

  it('retries parser creation after a rejected session attempt', async () => {
    const parser = await createHlslParser();
    let attempts = 0;
    const session = new LiveDocumentTreeSession(async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient parser failure');
      return parser;
    });

    try {
      await expect(session.indexFile(
        'file:///t/Retry.hlsl',
        'float4 FirstAttempt() { return 0; }',
      )).rejects.toThrow('transient parser failure');
      await expect(session.indexFile(
        'file:///t/Retry.hlsl',
        'float4 RecoveredAttempt() { return 0; }',
      )).resolves.toEqual(await indexFile(
        'file:///t/Retry.hlsl',
        'float4 RecoveredAttempt() { return 0; }',
      ));
      expect(attempts).toBe(2);
    } finally {
      session.dispose();
    }
  });

  it('releases removed ShaderLab block trees when the forest shrinks', async () => {
    const parser = await createHlslParser();
    const treeDeletes: Array<ReturnType<typeof vi.fn>> = [];
    const session = new LiveDocumentTreeSession(async () => ({
      parseStabilized(text, oldTree) {
        const tree = parser.parseStabilized(text, oldTree);
        const deleteTree = vi.fn(tree.delete.bind(tree));
        tree.delete = deleteTree;
        treeDeletes.push(deleteTree);
        return tree;
      },
      delete: parser.delete.bind(parser),
    }));
    const uri = 'file:///t/ShrinkingForest.shader';
    const withoutBlocks = 'Shader "Tests/NoPrograms" { SubShader { Pass {} } }';

    try {
      await session.indexFile(uri, shaderWithBlocks('FirstTree', 'SecondTree'));
      const incremental = await session.indexFile(uri, withoutBlocks);

      expect(incremental).toEqual(await indexFile(uri, withoutBlocks));
      expect(treeDeletes).toHaveLength(2);
      expect(treeDeletes.every((release) => release.mock.calls.length === 1)).toBe(true);
    } finally {
      session.dispose();
    }
  });
});

function shaderWithBlocks(first: string, second: string): string {
  return [
    'Shader "Tests/Forest" {',
    '  HLSLINCLUDE',
    `  float4 ${first}() { return 0; }`,
    '  ENDHLSL',
    '  SubShader {',
    '    Pass {',
    '      HLSLPROGRAM',
    `      float4 ${second}() { return 0; }`,
    '      ENDHLSL',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function editFixture(source: string, shader: boolean): string {
  const addedFunction = 'float4 IncrementalFixtureAdded() { return 1; }';
  if (!shader) return `${source}\n${addedFunction}\n`;
  const terminator = source.includes('ENDHLSL') ? 'ENDHLSL' : 'ENDCG';
  return source.replace(terminator, `${addedFunction}\n${terminator}`);
}

function shaderWithProgramBlocks(...names: readonly string[]): string {
  return [
    'Shader "Tests/ShiftedForest" {',
    '  SubShader {',
    ...names.flatMap((name) => [
      '    Pass {',
      '      HLSLPROGRAM',
      `      float4 ${name}() { return 0; }`,
      '      ENDHLSL',
      '    }',
    ]),
    '  }',
    '}',
  ].join('\n');
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
