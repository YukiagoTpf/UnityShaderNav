import { pathToFileURL } from 'node:url';
import type {
  Location,
  LocationLink,
} from 'vscode-languageserver/node';
import type { IncludeChain } from '../include';
import {
  cursorTargetAt,
  findPropertyCandidatesForName,
  findReferences,
  propertyAt,
  resolveDefinition,
  uniqueLocations,
  type ResolverContext,
} from '../index';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import type {
  DefinitionAtInput,
  ReferencesAtInput,
} from './indexedWorkspace';
import type { WorkspaceIndexReadView } from './workspaceIndex';

export interface WorkspaceNavigationState {
  readonly index: WorkspaceIndexReadView;
  readonly includeChain: IncludeChain;
  readonly isInPackages: (uri: string) => boolean;
  readonly includePackages: boolean;
  readonly definitionTrace: boolean;
}

/** Include jumps need only the immutable request text and include context. */
export function canNavigateDefinitionWithoutDocumentIndex(
  input: DefinitionAtInput,
): boolean {
  return cursorTargetAt(input.document.text, input.position).kind === 'include';
}

/**
 * Workspace-owned Definition behavior. The LSP adapter supplies immutable
 * request data and logging observers; index composition remains private here.
 */
export async function navigateDefinition(
  state: WorkspaceNavigationState,
  input: DefinitionAtInput,
): Promise<LocationLink[] | null> {
  const { document, position, observer } = input;
  const trace = (event: string, data: Record<string, unknown>): void => {
    if (state.definitionTrace) observer?.trace?.(event, data);
  };
  trace('request', {
    uri: document.uri,
    position,
    languageId: document.languageId,
  });

  const target = cursorTargetAt(document.text, position);
  if (target.kind === 'include') {
    const include = target.include;
    const resolved = await state.includeChain.resolve(include.path, document.uri);
    if (!resolved) return null;
    if (resolved.caseInsensitive) {
      observer?.caseInsensitiveInclude?.(include.path, resolved.absolutePath);
    }
    const targetUri = pathToFileURL(resolved.absolutePath).href;
    trace('include', { path: include.path, resolvedUri: targetUri });
    const targetRange = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    };
    return [{
      targetUri,
      targetRange,
      targetSelectionRange: targetRange,
      originSelectionRange: {
        start: { line: position.line, character: include.pathRange.start.character },
        end: { line: position.line, character: include.pathRange.end.character },
      },
    }];
  }

  const index = state.index.store.get(document.uri);
  if (!index) {
    trace('index.missing', { uri: document.uri });
    return null;
  }
  trace('index.loaded', {
    symbols: index.symbols.length,
    references: index.references.length,
  });

  // ShaderLab property -> HLSL declaration intentionally precedes the generic
  // HLSL lexical gate. Properties live outside HLSL blocks.
  const propertyHit = propertyAt(index, position);
  if (propertyHit) {
    trace('property.hit', { name: propertyHit.name });
    const visibleUriKeys = await state.includeChain.visibleUriKeys(document.uri);
    const symbols = resolveDefinition(
      {
        kind: 'symbol',
        word: { text: propertyHit.name, range: propertyHit.nameRange },
      },
      {
        index,
        global: state.index.global,
        position,
        options: { visibleUriKeys, trace },
      },
    ).filter((symbol) => symbol.kind === 'variable' || symbol.kind === 'cbuffer');
    if (symbols.length === 0) {
      trace('property.forward', { links: 0 });
      return null;
    }
    trace('property.forward', { links: symbols.length });
    return symbols.map((symbol) => ({
      targetUri: symbol.location.uri,
      targetRange: symbol.location.range,
      targetSelectionRange: symbol.location.range,
      originSelectionRange: propertyHit.nameRange,
    }));
  }

  if (!isGenericDefinitionContext(
    document.text,
    position,
    document.languageId,
    document.uri,
  )) {
    trace('context.rejected', {});
    return null;
  }

  const visibleUriKeys = await state.includeChain.visibleUriKeys(document.uri);
  const resolverContext: ResolverContext = {
    index,
    global: state.index.global,
    position,
    options: { visibleUriKeys, trace },
  };
  trace('visibility', { visibleUriCount: visibleUriKeys.size });

  if (target.kind === 'none') {
    trace('word.missing', {});
    return null;
  }

  const memberToken = target.kind === 'member' ? target.member : target.word;
  trace('memberAccess', {
    member: memberToken.text,
    receiver: target.kind === 'member' ? target.receiver.text : undefined,
  });
  if (target.kind === 'member') {
    const memberSymbols = resolveDefinition(target, resolverContext);
    if (memberSymbols.length > 0) {
      trace('member.result', { links: memberSymbols.length });
      return memberSymbols.map((symbol) => ({
        targetUri: symbol.location.uri,
        targetRange: symbol.location.range,
        targetSelectionRange: symbol.location.range,
        originSelectionRange: target.member.range,
      }));
    }
    trace('member.result', { links: 0 });
  }

  const word = memberToken;
  trace('word', { text: word.text, range: word.range });
  const symbols = resolveDefinition({ kind: 'symbol', word }, resolverContext);

  // Reverse property lookup intentionally spans the whole workspace so VS Code
  // can present every ambiguous shader property in Peek Definition.
  const propertyLinks: LocationLink[] = findPropertyCandidatesForName(
    word.text,
    state.index.store,
  ).map((candidate) => ({
    targetUri: candidate.uri,
    targetRange: candidate.entry.declarationRange,
    targetSelectionRange: candidate.entry.nameRange,
    originSelectionRange: word.range,
  }));

  if (symbols.length === 0 && propertyLinks.length === 0) {
    trace('definition.result', { links: 0 });
    return null;
  }
  trace('definition.result', {
    links: symbols.length + propertyLinks.length,
    hlsl: symbols.length,
    properties: propertyLinks.length,
  });
  const hlslLinks: LocationLink[] = symbols.map((symbol) => ({
    targetUri: symbol.location.uri,
    targetRange: symbol.location.range,
    targetSelectionRange: symbol.location.range,
    originSelectionRange: word.range,
  }));
  return [...hlslLinks, ...propertyLinks];
}

/** Workspace-owned Find References behavior. */
export async function navigateReferences(
  state: WorkspaceNavigationState,
  input: ReferencesAtInput,
): Promise<Location[] | null> {
  const { document, position } = input;
  const target = cursorTargetAt(document.text, position);
  if (target.kind === 'include') {
    const resolved = await state.includeChain.resolve(target.include.path, document.uri);
    if (!resolved) return null;

    const targetUri = pathToFileURL(resolved.absolutePath).href;
    const locations: Location[] = [];
    for (const uri of state.index.store.uris()) {
      const index = state.index.store.get(uri);
      if (!index) continue;

      for (const reference of index.references) {
        if (reference.context !== 'include') continue;
        if (!state.includePackages && state.isInPackages(reference.location.uri)) continue;

        const candidate = await state.includeChain.resolve(
          reference.name,
          reference.location.uri,
        );
        if (!candidate) continue;
        if (pathToFileURL(candidate.absolutePath).href !== targetUri) continue;
        locations.push({
          uri: reference.location.uri,
          range: reference.location.range,
        });
      }
    }
    return uniqueLocations(locations);
  }

  if (target.kind === 'none') return null;
  return findReferences(target, {
    index: state.index.store.get(document.uri),
    position,
    global: state.index.global,
    globalRefs: state.index.globalRefs,
    store: state.index.store,
    includeChain: state.includeChain,
    isInPackages: state.isInPackages,
    includePackages: state.includePackages,
    includeDeclaration: input.includeDeclaration,
  });
}
