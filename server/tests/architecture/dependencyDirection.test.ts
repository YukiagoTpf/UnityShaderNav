import {
  existsSync,
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
const QUERY_ADAPTERS = [
  'handlers/completion.ts',
  'handlers/definition.ts',
  'handlers/documentHighlight.ts',
  'handlers/documentSymbol.ts',
  'handlers/hover.ts',
  'handlers/references.ts',
  'handlers/semanticTokens.ts',
  'handlers/signatureHelp.ts',
  'handlers/workspaceSymbol.ts',
] as const;
const QUERY_ADAPTER_DEPENDENCIES = new Set([
  'lifecycle/requestSuspender.ts',
  'workspace/indexedWorkspace.ts',
]);
const QUERY_ADAPTER_NEUTRAL_DEPENDENCIES: Readonly<Partial<
  Record<(typeof QUERY_ADAPTERS)[number], readonly string[]>
>> = {
  'handlers/semanticTokens.ts': ['workspace/semanticTokenLegend.ts'],
};
const CONCRETE_QUERY_MODULES = new Set([
  'handlers/requestContext.ts',
  'workspace/indexedRevision.ts',
  'workspace/navigation.ts',
  'workspace/queries.ts',
  'workspace/workspace.ts',
  'workspace/workspaceIndex.ts',
  'workspace/workspaceManager.ts',
]);
const MUTABLE_INDEX_TYPES = [
  'IndexStore',
  'GlobalSymbolIndex',
  'GlobalReferenceIndex',
] as const;

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

  it('keeps every production query adapter behind the Indexed Workspace behavior', () => {
    const graph = buildSourceGraph(SOURCE_ROOT);
    for (const adapter of QUERY_ADAPTERS) {
      const neutralDependencies = new Set(
        QUERY_ADAPTER_NEUTRAL_DEPENDENCIES[adapter] ?? [],
      );
      const unexpectedDependency = (graph.get(adapter) ?? [])
        .find((dependency) => (
          !QUERY_ADAPTER_DEPENDENCIES.has(dependency)
          && !neutralDependencies.has(dependency)
        ));
      if (unexpectedDependency) {
        throw new Error(
          `${adapter} must depend only on the Indexed Workspace behavior, but imports ${unexpectedDependency}`,
        );
      }

      const violation = findDependencyPath(
        graph,
        [adapter],
        (moduleId) => moduleId.startsWith('index/')
          || moduleId.startsWith(PARSER_PREFIX)
          || moduleId.startsWith(SUGGESTIONS_PREFIX)
          || CONCRETE_QUERY_MODULES.has(moduleId),
      );
      if (violation) {
        throw new Error(
          `query adapter reached a concrete implementation: ${violation.join(' -> ')}`,
        );
      }

      const source = readFileSync(resolve(SOURCE_ROOT, adapter), 'utf8');
      expect(source, adapter).toMatch(/\bIndexedWorkspace\w*\b/);
      expect(source, adapter).not.toMatch(
        /\b(?:Workspace|WorkspaceIndex|IndexStore|GlobalSymbolIndex|GlobalReferenceIndex|TextDocuments|TextDocument)\b/,
      );
      expect(source).not.toMatch(/\.(?:index|store|global|globalRefs)\b/);
    }

    for (const adapter of QUERY_ADAPTERS.filter((candidate) => (
      candidate !== 'handlers/workspaceSymbol.ts'
    ))) {
      const source = readFileSync(resolve(SOURCE_ROOT, adapter), 'utf8');
      expect(source, adapter).toContain('workspaceForDocumentRequest');
    }
  });

  it('keeps mutable index storage private to the revision owner', () => {
    const sourceFiles = collectTypeScriptFiles(SOURCE_ROOT);
    const workspaceIndexId = 'workspace/workspaceIndex.ts';
    const indexedRevisionId = 'workspace/indexedRevision.ts';
    const readViewConsumers = new Set([
      workspaceIndexId,
      indexedRevisionId,
      'workspace/navigation.ts',
      'workspace/queries.ts',
    ]);

    const workspaceIndex = readFileSync(resolve(SOURCE_ROOT, workspaceIndexId), 'utf8');
    for (const field of ['store', 'global', 'globalRefs']) {
      expect(workspaceIndex, field).toMatch(
        new RegExp(`private\\s+readonly\\s+${field}\\b`),
      );
    }

    const indexedRevision = readFileSync(resolve(SOURCE_ROOT, indexedRevisionId), 'utf8');
    expect(indexedRevision.match(/private\s+readonly\s+index:\s*WorkspaceIndex\b/g))
      .toHaveLength(2);

    for (const sourceFile of sourceFiles) {
      const moduleId = relativeModuleId(SOURCE_ROOT, sourceFile);
      const source = readFileSync(sourceFile, 'utf8');

      if (moduleId !== workspaceIndexId && !moduleId.startsWith('index/')) {
        for (const mutableType of MUTABLE_INDEX_TYPES) {
          expect(source, moduleId).not.toMatch(new RegExp(`\\b${mutableType}\\b`));
        }
      }

      if (moduleId !== workspaceIndexId && moduleId !== indexedRevisionId) {
        expect(source, moduleId).not.toMatch(/\bWorkspaceIndex\b/);
        expect(source, moduleId).not.toMatch(/new\s+WorkspaceIndex\s*\(/);
        expect(source, moduleId).not.toMatch(/\.index\.read\b/);
      }

      if (!readViewConsumers.has(moduleId)) {
        expect(source, moduleId).not.toMatch(/\bWorkspaceIndexReadView\b/);
      }
    }
  });

  it('removes the legacy request-context escape hatch', () => {
    expect(existsSync(resolve(SOURCE_ROOT, 'handlers/requestContext.ts'))).toBe(false);
    for (const sourceFile of collectTypeScriptFiles(SOURCE_ROOT)) {
      const source = readFileSync(sourceFile, 'utf8');
      expect(source, relativeModuleId(SOURCE_ROOT, sourceFile))
        .not.toMatch(/handlers\/requestContext|from ['"]\.\/requestContext['"]/);
    }
  });

  it('prevents production live-document mutation from bypassing Workspace', () => {
    for (const sourceFile of collectTypeScriptFiles(SOURCE_ROOT)) {
      const source = readFileSync(sourceFile, 'utf8');
      expect(source, relativeModuleId(SOURCE_ROOT, sourceFile))
        .not.toMatch(/\.index\.(?:reindex|closeDocument)\s*\(/);
    }

    const rebuild = readFileSync(resolve(SOURCE_ROOT, 'lifecycle/rebuild.ts'), 'utf8');
    expect(rebuild).not.toMatch(/\.(?:store|global|globalRefs)\b/);
  });

  it('keeps migrated handler tests free of reconstructed Workspace internals', () => {
    const testRoot = resolve(SOURCE_ROOT, '../tests/handlers');
    for (const file of [
      'completion.test.ts',
      'definition.test.ts',
      'definition-include.test.ts',
      'definition-properties.test.ts',
      'documents.test.ts',
      'documentHighlight.test.ts',
      'documentSymbol.test.ts',
      'hover.test.ts',
      'references.test.ts',
      'semanticTokens.test.ts',
      'signatureHelp.test.ts',
      'workspaceSymbol.test.ts',
    ]) {
      const source = readFileSync(resolve(testRoot, file), 'utf8');
      expect(source, file).not.toMatch(/workspace\.index\b/);
      expect(source, file).not.toMatch(
        /index\s*:\s*\{[\s\S]{0,160}\b(?:store|global|globalRefs)\b/,
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
