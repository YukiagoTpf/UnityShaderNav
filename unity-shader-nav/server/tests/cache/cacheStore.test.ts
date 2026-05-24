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
import { describe, expect, it } from 'vitest';
import { CacheStore } from '../../src/cache/cacheStore';

const fingerprint: CacheFingerprint = {
  grammarVersion: 'g',
  settingsHash: 's',
  macroTableHash: 'm',
};

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 },
};

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
      grammarVersion: 'g1',
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
      fingerprint: { grammarVersion: 'g', settingsHash: 's', macroTableHash: 'm' },
      files: [],
    }), 'utf8');
    expect(await store.load()).toBeNull();

    await writeFile(join(dir, 'index.json'), JSON.stringify({
      version: CACHE_VERSION + 1,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: 123,
      fingerprint: { grammarVersion: 'g', settingsHash: 's', macroTableHash: 'm' },
      files: [],
    }), 'utf8');
    expect(await store.load()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects pre-macro-symbol cache manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-pre-macro-'));
    const store = new CacheStore(dir);

    await writeFile(join(dir, 'index.json'), JSON.stringify({
      version: 2,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: 123,
      fingerprint: { grammarVersion: 'g', settingsHash: 's', macroTableHash: 'm' },
      files: [],
    }), 'utf8');

    expect(await store.load()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects pre-member-receiver cache manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-pre-member-receiver-'));
    const store = new CacheStore(dir);

    await writeFile(join(dir, 'index.json'), JSON.stringify({
      version: 3,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: 123,
      fingerprint: { grammarVersion: 'g', settingsHash: 's', macroTableHash: 'm' },
      files: [],
    }), 'utf8');

    expect(await store.load()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when fingerprint mismatches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-fp-'));
    const store = new CacheStore(dir);
    const fpA: CacheFingerprint = {
      grammarVersion: 'a',
      settingsHash: 's1',
      macroTableHash: 'm1',
    };
    const fpB: CacheFingerprint = {
      grammarVersion: 'b',
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
      fingerprint: { grammarVersion: 'g', settingsHash: 's' },
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

  it('skips cached file records with malformed location ranges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-bad-range-'));
    const store = new CacheStore(dir);
    const file = validFile();

    await writeRawManifest(dir, validManifest({
      files: [
        {
          ...file,
          index: {
            ...file.index,
            symbols: [{
              name: 'Bad',
              kind: 'variable',
              location: { uri: file.uri, range: { start: { line: 0 } } },
            }],
          },
        } as never,
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

  it('skips cached file records whose nested locations differ from the index uri', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-mismatched-location-uri-'));
    const store = new CacheStore(dir);
    const file = validFile();
    const foreignUri = 'file:///x/Foreign.hlsl';

    await writeRawManifest(dir, validManifest({
      files: [
        {
          ...file,
          index: {
            ...file.index,
            symbols: [{
              ...file.index.symbols[0],
              location: { uri: foreignUri, range },
            }],
          },
        },
        {
          ...file,
          index: {
            ...file.index,
            references: [{
              ...file.index.references[0],
              location: { uri: foreignUri, range },
            }],
          },
        },
        file,
      ],
    }));

    expect((await store.load(fingerprint))?.files).toEqual([file]);

    await rm(dir, { recursive: true, force: true });
  });

  it('supports concurrent saves without sharing a tmp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-concurrent-'));
    const store = new CacheStore(dir);
    const fingerprint: CacheFingerprint = {
      grammarVersion: 'g',
      settingsHash: 's',
      macroTableHash: 'm',
    };

    await Promise.all(Array.from({ length: 8 }, (_, index) => store.save({
      version: CACHE_VERSION,
      workspaceFolderUri: `file:///x-${index}`,
      unityProjectRoot: '/x',
      createdAt: index,
      fingerprint,
      files: [],
    })));

    expect(await store.load(fingerprint)).not.toBeNull();

    await rm(dir, { recursive: true, force: true });
  });
});
