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

  it('keeps built-in semantic roles authoritative in the neutral vocabulary', () => {
    const vocabulary = readFileSync(resolve(SOURCE_ROOT, 'vocabulary.ts'), 'utf8');
    for (const api of [
      'findBuiltinEntries',
      'builtinEntriesForContext',
      'findBuiltinFunctions',
      'builtinLexicalRole',
      'asShaderLabPropertyType',
      'isShaderLabStateValueContext',
    ]) {
      expect(vocabulary, api).toMatch(new RegExp('export function ' + api + '\\b'));
    }
    expect(vocabulary).toMatch(/satisfies Record<ShaderLabPropertyType, true>/);
    expect(vocabulary).not.toMatch(/from ['"].*suggestions/);

    for (const sourceFile of collectTypeScriptFiles(SOURCE_ROOT)) {
      const moduleId = relativeModuleId(SOURCE_ROOT, sourceFile);
      if (moduleId === 'vocabulary.ts') continue;
      expect(readFileSync(sourceFile, 'utf8'), moduleId)
        .not.toMatch(/\bBUILTIN_ENTRIES\b/);
    }

    const consumers: ReadonlyArray<{
      readonly moduleId: string;
      readonly required: RegExp;
      readonly forbidden: RegExp;
    }> = [
      {
        moduleId: 'parser/shaderlab/tokenScanner.ts',
        required: /builtinLexicalRole|asShaderLabPropertyType/,
        forbidden: /SHADERLAB_KEYWORDS|PROPERTY_TYPES|BUILTIN_TOKEN_TYPES/,
      },
      {
        moduleId: 'parser/shaderlab/propertiesScanner.ts',
        required: /asShaderLabPropertyType/,
        forbidden: /\bPROPERTY_TYPES\b|as Set<string>/,
      },
      {
        moduleId: 'parser/lexical/cursor.ts',
        required: /isShaderLabStateValueContext/,
        forbidden: /SHADERLAB_STATE_VALUE_CONTEXTS/,
      },
      {
        moduleId: 'suggestions/builtins/filter.ts',
        required: /builtinEntriesForContext/,
        forbidden: /SHADERLAB_STATE_VALUE_NAMES|entry\.category|entry\.kind/,
      },
      {
        moduleId: 'suggestions/builtins/signatures.ts',
        required: /findBuiltinFunctions/,
        forbidden: /entry\.name|entry\.kind|entry\.parameters/,
      },
      {
        moduleId: 'documentation/resolver.ts',
        required: /findBuiltinEntries/,
        forbidden: /BUILTIN_ENTRIES\.filter/,
      },
    ];
    for (const consumer of consumers) {
      const source = readFileSync(resolve(SOURCE_ROOT, consumer.moduleId), 'utf8');
      expect(source, consumer.moduleId).toMatch(consumer.required);
      expect(source, consumer.moduleId).not.toMatch(consumer.forbidden);
    }
  });

  it('uses one parser runtime asset fact for execution and cache compatibility', () => {
    const parser = readFileSync(
      resolve(SOURCE_ROOT, 'parser/hlsl/parser.ts'),
      'utf8',
    );
    expect(parser).toMatch(/from ['"]\.\.\/runtimeAssets['"]/);
    expect(parser).toMatch(/loadHlslGrammar\s*\(/);
    expect(parser).not.toMatch(/tree-sitter-hlsl\.wasm|resolveWasmPath|existsSync/);

    const fingerprint = readFileSync(
      resolve(SOURCE_ROOT, 'cache/fingerprint.ts'),
      'utf8',
    );
    expect(fingerprint).toMatch(/ParserRuntimeAssets/);
    expect(fingerprint).not.toMatch(/readFile|no-wasm|wasmPath/);

    const candidate = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/indexedRevisionCandidate.ts'),
      'utf8',
    );
    expect(candidate).toMatch(/const runtimeAssets = await this\.preflightParser\(input\.signal\)/);
    expect(candidate).toMatch(/buildFingerprint\([\s\S]*?runtimeAssets/);
    expect(candidate).not.toMatch(/resolveWasmPath|tree-sitter-hlsl\.wasm|no-wasm/);
  });

  it('keeps compiled macro patterns private to the recognizer boundary', () => {
    const recognizer = readFileSync(
      resolve(SOURCE_ROOT, 'macros/recognizer.ts'),
      'utf8',
    );
    const publicApi = readFileSync(
      resolve(SOURCE_ROOT, 'macros/index.ts'),
      'utf8',
    );

    expect(recognizer).toMatch(/class MacroPatternRecognizer/);
    expect(recognizer).toMatch(/matchDeclarationCall/);
    expect(recognizer).toMatch(/scanReferencePatterns/);
    expect(recognizer).toMatch(/isStructuralSentinel/);
    expect(recognizer).toMatch(/builtinDeclarationMacroLexicalRole/);
    const representationDetails = /Compiled(?:Call|Declaration)?Pattern|parsePattern|\bcaptureIndex\b|\bparameterCount\b/;
    expect(publicApi).not.toMatch(representationDetails);
    expect(publicApi).not.toMatch(/\.\/builtin/);

    for (const removedModule of ['matcher.ts', 'patterns.ts', 'table.ts']) {
      expect(existsSync(resolve(SOURCE_ROOT, 'macros', removedModule))).toBe(false);
    }

    const consumers: ReadonlyArray<{
      readonly moduleId: string;
      readonly required: RegExp;
    }> = [
      {
        moduleId: 'parser/hlsl/collector.ts',
        required: /recognizer\.matchDeclarationCall|recognizer\.isStructuralSentinel/,
      },
      {
        moduleId: 'parser/hlsl/fileIndexer.ts',
        required: /recognizer\.scanReferencePatterns/,
      },
      {
        moduleId: 'parser/shaderlab/tokenScanner.ts',
        required: /builtinDeclarationMacroLexicalRole/,
      },
      {
        moduleId: 'cache/fingerprint.ts',
        required: /macroPatternIdentity/,
      },
    ];
    for (const consumer of consumers) {
      const source = readFileSync(resolve(SOURCE_ROOT, consumer.moduleId), 'utf8');
      expect(source, consumer.moduleId).toMatch(consumer.required);
      expect(source, consumer.moduleId).not.toMatch(representationDetails);
      expect(source, consumer.moduleId).not.toMatch(
        /findDecl|findRef|\.pattern\.split|macros\/builtin/,
      );
    }

    for (const sourceFile of collectTypeScriptFiles(SOURCE_ROOT)) {
      const moduleId = relativeModuleId(SOURCE_ROOT, sourceFile);
      if (moduleId === 'macros/recognizer.ts' || moduleId === 'macros/builtin.ts') continue;
      const source = readFileSync(sourceFile, 'utf8');
      expect(source, moduleId).not.toMatch(representationDetails);
      expect(source, moduleId).not.toMatch(/from ['"].*macros\/builtin['"]/);
    }
  });

  it('keeps complete candidate construction behind the Workspace publication seam', () => {
    const workspace = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/workspace.ts'),
      'utf8',
    );
    const candidate = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/indexedRevisionCandidate.ts'),
      'utf8',
    );

    expect(workspace).toMatch(/this\.candidateConstructor\.construct\(\{/);
    expect(workspace).toMatch(/const revision = builder\.publish\(next\)/);
    expect(workspace).toMatch(/this\.published = revision/);
    expect(workspace).toMatch(/await this\.persistRevision\(revision\)/);
    expect(workspace).not.toMatch(
      /\bstagedCandidate\b|\btakeStagedCandidate\b|\bbootstrap\s*\(|\bfullScan\s*\(/,
    );
    expect(workspace).not.toMatch(
      /buildFingerprint|CacheManager|detectUnityRoot|ensureParserReady|mapWithConcurrency|walkFiles/,
    );

    expect(candidate).toMatch(/class DefaultIndexedRevisionCandidateConstructor/);
    expect(candidate).toMatch(/Promise<IndexedRevisionBuilder>/);
    expect(candidate).toMatch(/PackageContext|cacheWorkspaceMatches|IndexedSourceMembership/);
    expect(candidate).not.toMatch(/walkFiles|isIndexableFilePath|Documentation~|Samples~/);
    expect(candidate).not.toMatch(/\bIndexLifecycle\b|\.publish\(|persistPublication/);
  });

  it('routes both open-document adapters through one reconciliation transition core', () => {
    const workspace = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/workspace.ts'),
      'utf8',
    );
    const reconciler = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/openDocumentReconciler.ts'),
      'utf8',
    );

    expect(workspace.match(/this\.documentReconciler\.apply\s*\(/g)).toHaveLength(2);
    expect(workspace).not.toMatch(/builder\.(?:prepareDocument|commitDocument|closeDocument)\s*\(/);
    expect(reconciler.match(/builder\.prepareDocument\s*\(/g)).toHaveLength(1);
    expect(reconciler.match(/builder\.commitDocument\s*\(/g)).toHaveLength(1);
    expect(reconciler.match(/builder\.closeDocument\s*\(/g)).toHaveLength(1);
    expect(reconciler).toMatch(/class OpenDocumentReconciler/);
    expect(reconciler).toMatch(/closedDocumentOpenIds/);
    expect(reconciler).toMatch(/openId[\s\S]*version|version[\s\S]*openId/);
    expect(reconciler).toMatch(/tombstone/);
  });

  it('keeps Quick Documentation policy in the revision-owned resolver', () => {
    const resolver = readFileSync(
      resolve(SOURCE_ROOT, 'documentation/resolver.ts'),
      'utf8',
    );
    const queries = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/queries.ts'),
      'utf8',
    );

    expect(resolver).toMatch(/documentationTargetAt\s*\(/);
    expect(resolver).toMatch(/findBuiltinEntries\s*\(/);
    expect(resolver).toMatch(/switch \(target\.role\)/);
    expect(resolver).toMatch(/declarations\.length > 0[\s\S]*resolveCurated/);
    expect(resolver).toMatch(/pkg\.official/);
    expect(resolver).toMatch(/supportedEditorVersions|supportedMajorVersions/);
    expect(resolver).toMatch(/visibleUriKeys\.has\(uriKey\(symbol\.location\.uri\)\)/);

    expect(queries).toMatch(/state\.documentation\.resolve\s*\(/);
    expect(queries).not.toMatch(
      /findBuiltinEntries|\bBuiltinEntry\b|quickDocumentation|\.roles|projectProvenance|\.curated\s*\(/,
    );
  });

  it('keeps indexed source membership policy in one revision-bound module', () => {
    const membership = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/indexedSourceMembership.ts'),
      'utf8',
    );
    const candidate = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/indexedRevisionCandidate.ts'),
      'utf8',
    );
    const revision = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/indexedRevision.ts'),
      'utf8',
    );
    const packages = readFileSync(
      resolve(SOURCE_ROOT, 'packages/packageContext.ts'),
      'utf8',
    );

    expect(membership).toMatch(/class IndexedSourceMembership/);
    expect(membership).toMatch(/walkFiles|isIndexableFilePath/);
    expect(candidate).toMatch(/IndexedSourceMembership\.create/);
    expect(candidate).toMatch(/membership\.discover|membership\.containsUri/);
    expect(revision).toMatch(/readonly membership: IndexedSourceMembership/);
    expect(revision).toMatch(/membership\.containsUri/);
    expect(revision).not.toMatch(/walkFiles|isIndexableFilePath|Documentation~|Samples~/);
    expect(packages).not.toMatch(/canRestoreCachedFile|walkFiles|isIndexableFilePath/);
  });

  it('keeps scope and proximity selection in one index-owned module', () => {
    const selection = readFileSync(
      resolve(SOURCE_ROOT, 'index/symbolSelection.ts'),
      'utf8',
    );
    const resolver = readFileSync(
      resolve(SOURCE_ROOT, 'index/symbolResolver.ts'),
      'utf8',
    );
    const chain = readFileSync(
      resolve(SOURCE_ROOT, 'index/chainLookup.ts'),
      'utf8',
    );
    const receiverSelection = sourceSection(
      chain,
      'function inferReceiverType(',
      'function inferReceiverTypeFromCallAssignment',
    );
    const suggestions = readFileSync(
      resolve(SOURCE_ROOT, 'suggestions/projectCandidates.ts'),
      'utf8',
    );

    expect(selection).toMatch(/selectNamedSymbolEntries/);
    expect(selection).toMatch(/scopeRange/);
    expect(selection).toMatch(/inRange|isBeforeOrAt/);
    expect(resolver).toMatch(/selectNamedSymbolEntries/);
    expect(resolver).not.toMatch(/scopeRange|inRange|isBeforeOrAt/);
    expect(receiverSelection).toMatch(/selectNamedSymbolEntries/);
    expect(receiverSelection).not.toMatch(/index\.symbols|scopeRange|laterThan/);
    expect(suggestions).toMatch(/selectSymbolEntryGroups/);
    expect(suggestions).not.toMatch(/scopeRange|inRange|isBeforeOrAt|laterThan/);
  });

  it('composes shared ShaderLab document facts at one production boundary', () => {
    const analysis = readFileSync(
      resolve(SOURCE_ROOT, 'analysis/documentAnalysis.ts'),
      'utf8',
    );
    expect(analysis).toMatch(/from ['"]\.\.\/parser\/shaderlab\/layoutScanner['"]/);
    expect(analysis).toMatch(/from ['"]\.\.\/parser\/shaderlab\/propertiesScanner['"]/);
    expect(analysis).toMatch(/from ['"]\.\.\/parser\/shaderlab\/tokenScanner['"]/);
    expect(analysis).toMatch(/from ['"]\.\.\/parser\/shaderlab\/sourceInterpretation['"]/);
    expect(analysis).not.toMatch(/analyzeInactiveRegions/);
    expect(analysis.match(/\binterpretShaderLabSource\s*\(/g)).toHaveLength(1);
    for (const projection of [
      'scanShaderLabLayoutFromSource',
      'scanShaderLabNamesFromSource',
      'scanShaderLabMaterialFactsFromSource',
      'scanShaderLabPropertyFactsFromSource',
      'scanShaderLabTokensFromSource',
    ]) {
      expect(analysis, projection).toMatch(new RegExp(`\\b${projection}\\s*\\(`));
    }

    const sourceInterpretation = readFileSync(
      resolve(SOURCE_ROOT, 'parser/shaderlab/sourceInterpretation.ts'),
      'utf8',
    );
    expect(sourceInterpretation.match(/\bscanCommentRoles\s*\(/g)).toHaveLength(1);
    for (const moduleId of [
      'parser/shaderlab/layoutScanner.ts',
      'parser/shaderlab/nameScanner.ts',
      'parser/shaderlab/materialCbufferScanner.ts',
      'parser/shaderlab/propertiesScanner.ts',
      'parser/shaderlab/tokenScanner.ts',
    ]) {
      const scanner = readFileSync(resolve(SOURCE_ROOT, moduleId), 'utf8');
      expect(scanner.match(/\binterpretShaderLabSource\s*\(/g), moduleId).toHaveLength(1);
    }

    const fileIndexer = readFileSync(
      resolve(SOURCE_ROOT, 'parser/hlsl/fileIndexer.ts'),
      'utf8',
    );
    expect(fileIndexer).toMatch(/from ['"]\.\.\/\.\.\/analysis['"]/);
    expect(fileIndexer).not.toMatch(/shaderlab\/(?:blockScanner|structureScanner|tokenScanner|propertiesScanner)/);
    expect(fileIndexer).toMatch(/analysis\.shaderLabProperties\.entries/);
    expect(fileIndexer).not.toMatch(/\bscanStructure\s*\(/);

    const tokenScanner = readFileSync(
      resolve(SOURCE_ROOT, 'parser/shaderlab/tokenScanner.ts'),
      'utf8',
    );
    expect(tokenScanner).not.toMatch(/blockScanner|\bscanBlocks\b/);

    const structureScanner = readFileSync(
      resolve(SOURCE_ROOT, 'parser/shaderlab/structureScanner.ts'),
      'utf8',
    );
    expect(structureScanner).toMatch(/from ['"]\.\/layoutScanner['"]/);
    expect(structureScanner).not.toMatch(/masking|sanitize/);

    const queries = readFileSync(resolve(SOURCE_ROOT, 'workspace/queries.ts'), 'utf8');
    expect(queries).not.toMatch(/shaderlab\/tokenScanner|\bscanShaderLabTokens\b/);

    const navigation = readFileSync(resolve(SOURCE_ROOT, 'workspace/navigation.ts'), 'utf8');
    expect(navigation).not.toMatch(/documentAnalysis|analyzeInactiveRegions/);

    const workspaceIndex = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/workspaceIndex.ts'),
      'utf8',
    );
    const diskRecord = /export interface DiskIndexRecord \{([\s\S]*?)\n\}/.exec(workspaceIndex)?.[1];
    expect(diskRecord).toBeDefined();
    expect(diskRecord).not.toMatch(/analysis|lexicalTokens/);
    for (const moduleId of ['cache/cacheManager.ts', 'cache/cacheStore.ts']) {
      expect(readFileSync(resolve(SOURCE_ROOT, moduleId), 'utf8'), moduleId)
        .not.toMatch(/DocumentAnalysis|lexicalTokens/);
    }

    for (const sourceFile of collectTypeScriptFiles(SOURCE_ROOT)) {
      const moduleId = relativeModuleId(SOURCE_ROOT, sourceFile);
      if (
        moduleId === 'analysis/documentAnalysis.ts'
        || moduleId === 'parser/shaderlab/blockScanner.ts'
        || moduleId === 'parser/shaderlab/nameScanner.ts'
        || moduleId === 'parser/shaderlab/materialCbufferScanner.ts'
        || moduleId === 'parser/shaderlab/tokenScanner.ts'
        || moduleId === 'parser/shaderlab/structureScanner.ts'
        || moduleId === 'parser/shaderlab/layoutScanner.ts'
        || moduleId === 'parser/shaderlab/propertiesScanner.ts'
        || moduleId === 'parser/shaderlab/sourceInterpretation.ts'
      ) continue;
      expect(readFileSync(sourceFile, 'utf8'), moduleId)
        .not.toMatch(/\b(?:interpretShaderLabSource|scanShaderLabTokens|scanStructure|scanShaderLabLayout|scanShaderLabNames|scanShaderLabMaterialFacts|scanShaderLabPropertyFacts)\s*\(/);
    }

    for (const moduleId of [
      'authoring/snippets.ts',
      'authoring/colors.ts',
      'authoring/formatting.ts',
      'handlers/colors.ts',
      'handlers/formatting.ts',
      'workspace/queries.ts',
    ]) {
      expect(readFileSync(resolve(SOURCE_ROOT, moduleId), 'utf8'), moduleId)
        .not.toMatch(/parser\/shaderlab\//);
    }
  });

  it('concentrates suggestion candidate policy behind one revision-bound selector', () => {
    expect(existsSync(resolve(SOURCE_ROOT, 'suggestions/projectSymbols.ts'))).toBe(false);
    expect(existsSync(resolve(SOURCE_ROOT, 'suggestions/memberContext.ts'))).toBe(false);

    const selector = readFileSync(
      resolve(SOURCE_ROOT, 'suggestions/projectCandidates.ts'),
      'utf8',
    );
    expect(selector).toMatch(/interface SuggestionCandidateSelector/);
    expect(selector).toMatch(/includeChain\.visibleUriKeys/);
    expect(selector).toMatch(/inferReceiverTypeForCompletion/);
    expect(selector).toMatch(/compatibleSignatureIndex/);
    expect(selector).toMatch(/mergeProjectAndBuiltinSuggestions/);

    const barrel = readFileSync(resolve(SOURCE_ROOT, 'suggestions/index.ts'), 'utf8');
    expect(barrel).toMatch(/export \* from ['"]\.\/projectCandidates['"]/);
    expect(barrel).not.toMatch(/projectSymbols|memberContext/);

    const queries = readFileSync(resolve(SOURCE_ROOT, 'workspace/queries.ts'), 'utf8');
    const completion = sourceSection(
      queries,
      'export async function queryCompletion',
      'export async function querySignatureHelp',
    );
    const signature = sourceSection(
      queries,
      'export async function querySignatureHelp',
      'export async function queryHighlights',
    );
    for (const [name, source] of [['completion', completion], ['signature', signature]]) {
      expect(source, name).toMatch(/state\.suggestionCandidates\.select/);
      expect(source, name).not.toMatch(
        /state\.index|visibleUriKeys|collectVisibleUriKeys|collectVisibleProject|collectMemberSuggestions|inferReceiverTypeForCompletion/,
      );
    }

    const revision = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/indexedRevision.ts'),
      'utf8',
    );
    expect(revision).toMatch(
      /private readonly suggestionCandidates: SuggestionCandidateSelector/,
    );
    expect(revision).toMatch(/createSuggestionCandidateSelector\([\s\S]*?index\.read/);
    expect(revision).toMatch(/suggestionCandidates: this\.suggestionCandidates/);
  });

  it('binds one memoized Include chain to each published revision and every visibility query', () => {
    const includeChain = readFileSync(
      resolve(SOURCE_ROOT, 'include/includeChain.ts'),
      'utf8',
    );
    expect(includeChain).toMatch(/interface IncludeChain/);
    expect(includeChain).toMatch(/resolveInclude/);
    expect(includeChain).toMatch(/visibleUriKeys/);
    expect(includeChain).toMatch(/const visible = new Set<string>\(\)/);
    expect(includeChain).toMatch(/const revisionProbe = memoizeDirectoryListings\(probe\)/);
    expect(includeChain).toMatch(/resolutionsBySource/);
    expect(includeChain).toMatch(/visibleClosures/);
    expect(includeChain).toMatch(/return closure\.then\(\(visible\) => new Set\(visible\)\)/);
    expect(existsSync(resolve(SOURCE_ROOT, 'index/visibility.ts'))).toBe(false);

    const includeResolver = readFileSync(
      resolve(SOURCE_ROOT, 'include/resolver.ts'),
      'utf8',
    );
    expect(includeResolver).toMatch(/function memoizeDirectoryListings/);
    expect(includeResolver).toMatch(/new Map<string, Promise<readonly string\[\]>>\(\)/);

    const revision = readFileSync(
      resolve(SOURCE_ROOT, 'workspace/indexedRevision.ts'),
      'utf8',
    );
    expect(revision).toMatch(/private readonly includeChain: IncludeChain/);
    expect(revision).toMatch(
      /const packageIncludeContext = configuration\.packages\.includeCtx[\s\S]*?this\.includeChain = createIncludeChain\([\s\S]*?index\.read\.store[\s\S]*?configuration\.settings\.includeDirectories/,
    );
    expect(revision).toMatch(/includeChain: this\.includeChain/g);
    expect(revision).toMatch(/createSuggestionCandidateSelector\([\s\S]*?this\.includeChain/);

    for (const moduleId of [
      'workspace/navigation.ts',
      'workspace/queries.ts',
      'suggestions/projectCandidates.ts',
      'index/resolution.ts',
    ]) {
      const source = readFileSync(resolve(SOURCE_ROOT, moduleId), 'utf8');
      expect(source, moduleId).toMatch(/IncludeChain/);
      expect(source, moduleId).not.toMatch(/resolveInclude|collectVisibleUriKeys|\.includeCtx/);
    }

    const resolver = readFileSync(
      resolve(SOURCE_ROOT, 'packages/packageResolver.ts'),
      'utf8',
    );
    expect(resolver).not.toMatch(/resolveIncludePath/);
  });

  it('keeps test-only lifecycle seams and rebuild suspension out of production', () => {
    const rebuild = readFileSync(
      resolve(SOURCE_ROOT, 'lifecycle/rebuild.ts'),
      'utf8',
    );
    const watcher = readFileSync(
      resolve(SOURCE_ROOT, 'lifecycle/fileWatcher.ts'),
      'utf8',
    );
    const coordinator = readFileSync(
      resolve(SOURCE_ROOT, 'lifecycle/workspaceFolderCoordinator.ts'),
      'utf8',
    );
    const server = readFileSync(resolve(SOURCE_ROOT, 'server.ts'), 'utf8');

    expect(rebuild).toMatch(/export async function applyScopedSettingsAndRebuild/);
    expect(rebuild).toMatch(/export async function rebuildWorkspaces/);
    expect(rebuild).not.toMatch(
      /applySettingsAndRebuild|RequestSuspender|RebuildSuspender|settingsForRebuild|_suspender/,
    );
    expect(watcher).toMatch(/export function registerFileWatchers/);
    expect(watcher).not.toMatch(
      /applyWorkspaceFolderChanges|WorkspaceFolderChange|RequestSuspender|suspender/,
    );
    expect(coordinator).toMatch(/initializeWorkspaceFolders/);
    expect(coordinator).toMatch(/registerWorkspaceFolderCoordinator/);

    expect(server).toMatch(/registerFileWatchers\(connection, manager\)/);
    expect(server).toMatch(
      /applyScopedSettingsAndRebuild\(\s*connection,\s*manager,\s*\(folderUri\) => loadSettings\(connection, folderUri\),\s*\)/,
    );
    const statusRegistration = server.indexOf(`connection.onRequest(\n  INDEX_STATUS_REQUEST`);
    const coldStart = server.indexOf('connection.onInitialized');
    expect(statusRegistration).toBeGreaterThanOrEqual(0);
    expect(statusRegistration).toBeLessThan(coldStart);

    for (const sourceFile of collectTypeScriptFiles(SOURCE_ROOT)) {
      const moduleId = relativeModuleId(SOURCE_ROOT, sourceFile);
      const source = readFileSync(sourceFile, 'utf8');
      if (
        moduleId === 'server.ts'
        || moduleId === 'lifecycle/requestSuspender.ts'
        || moduleId.startsWith('handlers/')
      ) continue;
      expect(source, moduleId).not.toMatch(/RequestSuspender/);
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

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`missing source section: ${start} -> ${end}`);
  }
  return source.slice(startIndex, endIndex);
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
