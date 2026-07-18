import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_VERSION,
  type CachedFile,
  type CacheFingerprint,
  type CacheManifest,
  type FileIndex,
} from '@unity-shader-nav/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheStore } from '../../src/cache/cacheStore';
import * as fileIndexCodec from '../../src/cache/fileIndexCodec';

const fsMock = vi.hoisted(() => ({
  failNextRename: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      rename: async (...args: Parameters<typeof actual.promises.rename>) => {
        if (fsMock.failNextRename) {
          fsMock.failNextRename = false;
          throw new Error('rename failed');
        }
        return actual.promises.rename(...args);
      },
    },
  };
});

const fingerprint: CacheFingerprint = {
  releaseVersion: '0.1.1',
  grammarVersion: 'c'.repeat(64),
  settingsHash: 's',
  macroTableHash: 'm',
};

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 },
};

afterEach(() => {
  vi.restoreAllMocks();
  fsMock.failNextRename = false;
});

function validIndex(uri = 'file:///x/Valid.hlsl'): FileIndex {
  return {
    uri,
    symbols: [{
      name: 'Valid',
      kind: 'variable',
      location: { uri, range },
    }],
    references: [{
      name: 'Valid',
      context: 'identifier',
      location: { uri, range },
    }],
  };
}

function validFile(uri = 'file:///x/Valid.hlsl'): CachedFile {
  return {
    uri,
    mtimeMs: 1,
    size: 10,
    index: validIndex(uri),
  };
}

function validManifest(overrides: Partial<CacheManifest> = {}): CacheManifest {
  return {
    version: CACHE_VERSION,
    workspaceFolderUri: 'file:///x',
    unityProjectRoot: '/x',
    createdAt: 123,
    fingerprint,
    files: [],
    ...overrides,
  };
}

async function writeRawManifest(dir: string, manifest: unknown): Promise<void> {
  await writeFile(join(dir, 'index.json'), JSON.stringify(manifest), 'utf8');
}

describe('CacheStore', () => {
  it('returns null when no manifest exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-missing-'));
    const store = new CacheStore(dir);

    expect(await store.load()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('saves and loads a valid manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-valid-'));
    const store = new CacheStore(dir);
    const fingerprint: CacheFingerprint = {
      releaseVersion: '0.2.0',
      grammarVersion: 'd'.repeat(64),
      settingsHash: 's1',
      macroTableHash: 'm1',
    };

    await store.save({
      version: CACHE_VERSION,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: 123,
      fingerprint,
      files: [],
    });

    expect(await store.load(fingerprint)).toMatchObject({
      version: CACHE_VERSION,
      workspaceFolderUri: 'file:///x',
      fingerprint,
    });

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects an incompatible fingerprint before traversing file payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-fingerprint-first-'));
    const store = new CacheStore(dir);
    const realDecoder = fileIndexCodec.decodePersistedFileIndex;
    const decoder = vi.spyOn(fileIndexCodec, 'decodePersistedFileIndex')
      .mockImplementation((...args) => realDecoder(...args));
    await writeRawManifest(dir, validManifest({ files: [validFile()] }));

    await expect(store.load({
      ...fingerprint,
      releaseVersion: '9.9.9',
    })).resolves.toBeNull();
    expect(decoder).not.toHaveBeenCalled();

    await expect(store.load(fingerprint)).resolves.toMatchObject({ files: [validFile()] });
    expect(decoder).toHaveBeenCalledOnce();

    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips ShaderLab property, name, and material facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-shaderlab-names-'));
    const store = new CacheStore(dir);
    const uri = 'file:///x/Named.shader';
    const index: FileIndex = {
      ...validIndex(uri),
      properties: [{
        name: '_Color',
        nameRange: range,
        declarationRange: range,
        type: 'Color',
      }],
      shaderLabNames: {
        shaders: [{ name: 'Library/Lit', nameRange: range, declarationRange: range }],
        passes: [{
          shaderName: 'Library/Lit',
          name: 'ForwardLit',
          canonicalName: 'FORWARDLIT',
          nameRange: range,
          declarationRange: range,
        }],
        references: [{
          kind: 'usePass',
          shaderName: 'Library/Lit',
          passName: 'FORWARDLIT',
          canonicalPassName: 'FORWARDLIT',
          shaderNameRange: range,
          passNameRange: range,
          directiveRange: range,
        }],
      },
      shaderLabMaterial: {
        srpEvidence: true,
        subShaderCount: 1,
        hasIncludes: false,
        lineEnding: '\n',
        cbuffers: [{
          name: 'UnityPerMaterial',
          nameRange: range,
          declarationRange: range,
          fields: [{
            name: '_Color',
            type: 'float4',
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
          startLine: 0,
          endLine: 2,
          insertionPosition: range.start,
          indent: '',
          unterminated: false,
        }],
      },
    };

    await store.save(validManifest({
      files: [{ uri, mtimeMs: 1, size: 10, index }],
    }));

    const restored = (await store.load(fingerprint))?.files[0].index;
    expect(restored?.properties).toEqual(index.properties);
    expect(restored?.shaderLabNames).toEqual(index.shaderLabNames);
    expect(restored?.shaderLabMaterial).toEqual(index.shaderLabMaterial);
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for malformed JSON or unsupported versions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-invalid-'));
    const store = new CacheStore(dir);

    await writeFile(join(dir, 'index.json'), '{nope', 'utf8');
    expect(await store.load()).toBeNull();

    await writeFile(join(dir, 'index.json'), JSON.stringify({
      version: CACHE_VERSION - 1,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: 123,
      fingerprint: { grammarVersion: 'c'.repeat(64), settingsHash: 's', macroTableHash: 'm' },
      files: [],
    }), 'utf8');
    expect(await store.load()).toBeNull();

    await writeFile(join(dir, 'index.json'), JSON.stringify({
      version: CACHE_VERSION + 1,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: 123,
      fingerprint: { grammarVersion: 'c'.repeat(64), settingsHash: 's', macroTableHash: 'm' },
      files: [],
    }), 'utf8');
    expect(await store.load()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the release version mismatches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-fp-'));
    const store = new CacheStore(dir);
    const fpA: CacheFingerprint = {
      releaseVersion: '0.1.1',
      grammarVersion: 'c'.repeat(64),
      settingsHash: 's1',
      macroTableHash: 'm1',
    };
    const fpB: CacheFingerprint = {
      releaseVersion: '0.2.0',
      grammarVersion: 'c'.repeat(64),
      settingsHash: 's1',
      macroTableHash: 'm1',
    };

    await store.save({
      version: CACHE_VERSION,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: Date.now(),
      fingerprint: fpA,
      files: [],
    });

    expect(await store.load(fpA)).not.toBeNull();
    expect(await store.load(fpB)).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the manifest is missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-missing-files-'));
    const store = new CacheStore(dir);

    const { files: _files, ...manifest } = validManifest();
    await writeRawManifest(dir, manifest);

    expect(await store.load(fingerprint)).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the manifest files field is not an array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-non-array-files-'));
    const store = new CacheStore(dir);

    await writeRawManifest(dir, {
      ...validManifest(),
      files: {},
    });

    expect(await store.load(fingerprint)).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the manifest fingerprint is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-bad-fingerprint-'));
    const store = new CacheStore(dir);

    await writeRawManifest(dir, {
      ...validManifest(),
      fingerprint: { grammarVersion: 'c'.repeat(64), settingsHash: 's' },
    });

    expect(await store.load()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('skips malformed cached file records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-bad-file-'));
    const store = new CacheStore(dir);
    const file = validFile();

    await writeRawManifest(dir, validManifest({
      files: [
        file,
        { ...file, uri: 123 } as never,
      ],
    }));

    expect((await store.load(fingerprint))?.files).toEqual([file]);

    await rm(dir, { recursive: true, force: true });
  });

  it('skips cached file records with malformed index symbols', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-bad-symbols-'));
    const store = new CacheStore(dir);
    const file = validFile();

    await writeRawManifest(dir, validManifest({
      files: [
        { ...file, index: { ...file.index, symbols: 'bad' } } as never,
        file,
      ],
    }));

    expect((await store.load(fingerprint))?.files).toEqual([file]);

    await rm(dir, { recursive: true, force: true });
  });

  it('skips cached file records with non-record projection entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-bad-entry-'));
    const store = new CacheStore(dir);
    const file = validFile();

    await writeRawManifest(dir, validManifest({
      files: [
        { ...file, index: { ...file.index, symbols: [null] } } as never,
        file,
      ],
    }));

    expect((await store.load(fingerprint))?.files).toEqual([file]);

    await rm(dir, { recursive: true, force: true });
  });

  it('skips cached file records whose index uri differs from the file uri', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-mismatched-index-uri-'));
    const store = new CacheStore(dir);
    const file = validFile();

    await writeRawManifest(dir, validManifest({
      files: [
        {
          ...file,
          index: validIndex('file:///x/Foreign.hlsl'),
        },
        file,
      ],
    }));

    expect((await store.load(fingerprint))?.files).toEqual([file]);

    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the previous manifest when replacing the cache manifest fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-preserve-'));
    const store = new CacheStore(dir);
    const first = validManifest({ workspaceFolderUri: 'file:///first', createdAt: 1 });
    const second = validManifest({ workspaceFolderUri: 'file:///second', createdAt: 2 });

    await store.save(first);
    fsMock.failNextRename = true;

    await expect(store.save(second)).rejects.toThrow('rename failed');

    expect(await store.load(fingerprint)).toMatchObject({
      workspaceFolderUri: 'file:///first',
      createdAt: 1,
    });

    await rm(dir, { recursive: true, force: true });
  });

});
