import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadHlslGrammar,
  resolveParserRuntimeAssets,
  tryResolveParserRuntimeAssets,
  type ParserRuntimeLayout,
} from '../../src/parser/runtimeAssets';

interface LayoutFixture {
  readonly layout: ParserRuntimeLayout;
  readonly modulePath: string;
  readonly grammarPath: string;
}

describe('parser runtime assets', () => {
  it.each([
    'source',
    'tsc-out',
    'copied-server',
    'bundled-server',
  ] as const)('resolves and snapshots the %s layout', async (layout) => {
    const root = await mkdtemp(join(tmpdir(), `usn-runtime-assets-${layout}-`));
    try {
      const fixture = layoutFixture(root, layout);
      await mkdir(join(fixture.modulePath, '..'), { recursive: true });
      await mkdir(join(fixture.grammarPath, '..'), { recursive: true });
      await writeFile(fixture.modulePath, 'module bytes\n');
      await writeFile(fixture.grammarPath, 'grammar A\n');

      const assets = resolveParserRuntimeAssets(fixture.modulePath);
      expect(assets.layout).toBe(layout);
      const [resolvedAssetPath, resolvedFixturePath] = await Promise.all([
        realpath(assets.hlslGrammar.path),
        realpath(fixture.grammarPath),
      ]);
      expect(resolvedAssetPath).toBe(resolvedFixturePath);
      expect(assets.hlslGrammar.byteLength).toBe(Buffer.byteLength('grammar A\n'));
      expect(assets.hlslGrammar.contentHash).toBe(
        createHash('sha256').update('grammar A\n').digest('hex'),
      );
      expect(Buffer.from(assets.hlslGrammar.readBytes()).toString()).toBe('grammar A\n');

      let loaded = Buffer.alloc(0);
      const language = await loadHlslGrammar(assets, async (bytes) => {
        loaded = Buffer.from(bytes);
        return 'loaded-language';
      });
      expect(language).toBe('loaded-language');
      expect(loaded).toEqual(Buffer.from(assets.hlslGrammar.readBytes()));

      await writeFile(fixture.grammarPath, 'grammar B\n');
      expect(Buffer.from(assets.hlslGrammar.readBytes()).toString()).toBe('grammar A\n');
      expect(resolveParserRuntimeAssets(fixture.modulePath).hlslGrammar.contentHash)
        .not.toBe(assets.hlslGrammar.contentHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing asset instead of returning a guessed path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-runtime-assets-missing-'));
    try {
      const fixture = layoutFixture(root, 'source');
      await mkdir(join(fixture.modulePath, '..'), { recursive: true });
      await writeFile(fixture.modulePath, 'module bytes\n');

      expect(() => resolveParserRuntimeAssets(fixture.modulePath))
        .toThrow(/Unable to load parser runtime asset/);
      expect(tryResolveParserRuntimeAssets(fixture.modulePath)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unknown layout even when a plausible grammar exists nearby', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-runtime-assets-unknown-'));
    try {
      const modulePath = join(root, 'random', 'parser', 'runtimeAssets.js');
      const guessedGrammar = join(root, 'random', 'grammars', 'tree-sitter-hlsl.wasm');
      await mkdir(join(modulePath, '..'), { recursive: true });
      await mkdir(join(guessedGrammar, '..'), { recursive: true });
      await writeFile(modulePath, 'module bytes\n');
      await writeFile(guessedGrammar, 'grammar bytes\n');

      expect(() => resolveParserRuntimeAssets(modulePath))
        .toThrow(/Unsupported parser runtime layout/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function layoutFixture(root: string, layout: ParserRuntimeLayout): LayoutFixture {
  switch (layout) {
    case 'source':
      return {
        layout,
        modulePath: join(root, 'server', 'src', 'parser', 'runtimeAssets.ts'),
        grammarPath: join(root, 'server', 'grammars', 'tree-sitter-hlsl.wasm'),
      };
    case 'tsc-out':
      return {
        layout,
        modulePath: join(root, 'server', 'out', 'parser', 'runtimeAssets.js'),
        grammarPath: join(root, 'server', 'grammars', 'tree-sitter-hlsl.wasm'),
      };
    case 'copied-server':
      return {
        layout,
        modulePath: join(root, 'client', 'out', 'server', 'parser', 'runtimeAssets.js'),
        grammarPath: join(root, 'client', 'out', 'grammars', 'tree-sitter-hlsl.wasm'),
      };
    case 'bundled-server':
      return {
        layout,
        modulePath: join(root, 'client', 'out', 'server', 'server.js'),
        grammarPath: join(root, 'client', 'out', 'grammars', 'tree-sitter-hlsl.wasm'),
      };
  }
}
