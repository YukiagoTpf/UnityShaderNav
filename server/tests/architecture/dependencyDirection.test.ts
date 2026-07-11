import {
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type DependencyGraph = ReadonlyMap<string, readonly string[]>;

const SOURCE_ROOT = resolve(__dirname, '../../src');
const PARSER_PREFIX = 'parser/';
const SUGGESTIONS_PREFIX = 'suggestions/';

describe('server dependency direction', () => {
  it('extracts every TypeScript dependency form used by the guard', () => {
    const source = [
      "import value from './value';",
      "import type { TypeOnly } from './type-only';",
      "export { forwarded } from './forwarded';",
      "export type { ForwardedType } from './forwarded-type';",
      "export * from './star';",
      "const required = require('./required');",
      "const lazy = import('./lazy');",
    ].join('\n');

    expect(importSpecifiers(source)).toEqual([
      './value',
      './type-only',
      './forwarded',
      './forwarded-type',
      './star',
      './required',
      './lazy',
    ]);
  });

  it('reports a complete transitive dependency chain', () => {
    const graph: DependencyGraph = new Map([
      ['parser/scan.ts', ['vocabulary.ts']],
      ['vocabulary.ts', ['adapter.ts']],
      ['adapter.ts', ['suggestions/index.ts']],
      ['suggestions/index.ts', []],
    ]);

    expect(findDependencyPath(
      graph,
      ['parser/scan.ts'],
      (moduleId) => moduleId.startsWith(SUGGESTIONS_PREFIX),
    )).toEqual([
      'parser/scan.ts',
      'vocabulary.ts',
      'adapter.ts',
      'suggestions/index.ts',
    ]);
  });

  it('resolves source modules with the server TypeScript configuration', () => {
    const sourceFiles = collectTypeScriptFiles(SOURCE_ROOT);
    const sourceFileSet = new Set(sourceFiles.map((sourceFile) => resolve(sourceFile)));
    const compilerOptions = readCompilerOptions(SOURCE_ROOT);
    const importer = join(SOURCE_ROOT, 'parser/shaderlab/tokenScanner.ts');

    expect(resolveSourceModule(
      SOURCE_ROOT,
      sourceFileSet,
      compilerOptions,
      importer,
      '../../vocabulary',
    )).toBe('vocabulary.ts');
    expect(resolveSourceModule(
      SOURCE_ROOT,
      sourceFileSet,
      compilerOptions,
      importer,
      '../../suggestions',
    )).toBe('suggestions/index.ts');
    expect(resolveSourceModule(
      SOURCE_ROOT,
      sourceFileSet,
      compilerOptions,
      importer,
      '../../suggestions/index.js',
    )).toBe('suggestions/index.ts');
    expect(() => resolveSourceModule(
      SOURCE_ROOT,
      sourceFileSet,
      compilerOptions,
      importer,
      '../../missing-module',
    )).toThrow(/cannot resolve \.\.\/\.\.\/missing-module imported by parser\/shaderlab\/tokenScanner\.ts/);
  });

  it('prevents parser modules from reaching suggestion modules', () => {
    const graph = buildSourceGraph(SOURCE_ROOT);
    const parserModules = [...graph.keys()].filter((moduleId) => (
      moduleId.startsWith(PARSER_PREFIX)
    ));
    expect(parserModules.length).toBeGreaterThan(0);
    expect([...graph.keys()].some((moduleId) => (
      moduleId.startsWith(SUGGESTIONS_PREFIX)
    ))).toBe(true);
    const violation = findDependencyPath(
      graph,
      parserModules,
      (moduleId) => moduleId.startsWith(SUGGESTIONS_PREFIX),
    );

    if (violation) {
      throw new Error(
        `parser modules must not depend on suggestions: ${violation.join(' -> ')}`,
      );
    }
  });
});

function buildSourceGraph(sourceRoot: string): DependencyGraph {
  const sourceFiles = collectTypeScriptFiles(sourceRoot);
  const sourceFileSet = new Set(sourceFiles.map((sourceFile) => resolve(sourceFile)));
  const compilerOptions = readCompilerOptions(sourceRoot);
  const graph = new Map<string, readonly string[]>();

  for (const sourceFile of sourceFiles) {
    const moduleId = relativeModuleId(sourceRoot, sourceFile);
    const dependencies = importSpecifiers(readFileSync(sourceFile, 'utf8'))
      .map((specifier) => resolveSourceModule(
        sourceRoot,
        sourceFileSet,
        compilerOptions,
        sourceFile,
        specifier,
      ))
      .filter((dependency): dependency is string => dependency !== undefined);
    graph.set(moduleId, [...new Set(dependencies)].sort());
  }

  return graph;
}

function readCompilerOptions(sourceRoot: string): ts.CompilerOptions {
  const configPath = resolve(sourceRoot, '../tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(sourceRoot, '..'),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n'));
  }
  return parsed.options;
}

function collectTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && extname(entry.name) === '.ts') {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

function importSpecifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles
    .map((dependency) => dependency.fileName);
}

function resolveSourceModule(
  sourceRoot: string,
  sourceFileSet: ReadonlySet<string>,
  compilerOptions: ts.CompilerOptions,
  importer: string,
  specifier: string,
): string | undefined {
  const resolvedModule = ts.resolveModuleName(
    specifier,
    importer,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (!resolvedModule) {
    if (specifier.startsWith('.')) {
      throw new Error(
        `cannot resolve ${specifier} imported by ${relativeModuleId(sourceRoot, importer)}`,
      );
    }
    return undefined;
  }

  const resolvedFile = resolve(resolvedModule.resolvedFileName);
  if (!sourceFileSet.has(resolvedFile)) return undefined;
  return relativeModuleId(sourceRoot, resolvedFile);
}

function relativeModuleId(sourceRoot: string, path: string): string {
  return relative(sourceRoot, path).split(sep).join('/');
}

function findDependencyPath(
  graph: DependencyGraph,
  starts: readonly string[],
  isTarget: (moduleId: string) => boolean,
): string[] | undefined {
  const queue = [...starts].sort().map((start) => [start]);
  const visited = new Set(queue.map(([start]) => start));

  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    if (isTarget(current)) return path;

    for (const dependency of graph.get(current) ?? []) {
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      queue.push([...path, dependency]);
    }
  }

  return undefined;
}
