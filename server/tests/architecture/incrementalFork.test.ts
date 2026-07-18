import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(__dirname, '../../src');

describe('incremental WorkspaceIndex forks', () => {
  it('shares persistent per-file roots without enumerating the workspace', () => {
    const source = readFileSync(
      resolve(sourceRoot, 'workspace/workspaceIndex.ts'),
      'utf8',
    );
    const start = source.indexOf('  fork(): WorkspaceIndex {');
    const end = source.indexOf('\n  /** Restore a disk record', start);
    const fork = source.slice(start, end);

    expect(fork).toMatch(/store: this\.store\.fork\(\)/);
    expect(fork).toMatch(/global: this\.global\.fork\(\)/);
    expect(fork).toMatch(/globalRefs: this\.globalRefs\.fork\(\)/);
    expect(fork).toMatch(/diskIndexes: this\.diskIndexes/);
    expect(fork).not.toMatch(/\bfor\s*\(|\.uris\(\)|new Map/);
  });

  it('keeps global symbol and reference aggregation behind file shards', () => {
    for (const moduleId of ['index/globalIndex.ts', 'index/globalReferences.ts']) {
      const source = readFileSync(resolve(sourceRoot, moduleId), 'utf8');
      expect(source, moduleId).toMatch(/FileShardIndex/);
      expect(source, moduleId).toMatch(/\.shards\.fork\(\)/);
      expect(source, moduleId).not.toMatch(/new Map/);
    }
  });
});
