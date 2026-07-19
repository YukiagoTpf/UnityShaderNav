import { pathToFileURL } from 'node:url';
import type {
  FileIndex,
  ShaderLabPropertyEntry,
} from '@unity-shader-nav/shared';
import type {
  Location,
  LocationLink,
} from 'vscode-languageserver/node';
import type { IncludeChain } from '../include';
import {
  awaitWithRequestCancellation,
  cooperativeRequestCheckpoint,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import {
  cursorTargetAt,
  findPropertyCandidatesForName,
  findReferences,
  propertyAt,
  resolveDefinition,
  uniqueLocations,
  type CursorTarget,
  type ResolverContext,
} from '../index';
import {
  isGenericDefinitionContext,
  isGenericDefinitionCursor,
} from '../parser/lexical/context';
import { isShaderLabUri, symbolToLocationLink } from '../sourceLocation';
import type {
  DefinitionAtInput,
  ReferencesAtInput,
} from './indexedWorkspace';
import type { WorkspaceIndexReadView } from './workspaceIndex';
import type { CursorRequestFacts } from './requestFacts';
import {
  shaderLabNameDefinitions,
  shaderLabNameReferences,
  shaderLabNameTargetAt,
  type ShaderLabNameTarget,
} from './shaderLabNames';
import { variantContextStore } from './variantContextStore';

export interface WorkspaceNavigationState {
  readonly index: WorkspaceIndexReadView;
  readonly includeChain: IncludeChain;
  readonly isInPackages: (uri: string) => boolean;
  readonly includePackages: boolean;
  readonly definitionTrace: boolean;
}

type DefinitionTrace = (event: string, data: Record<string, unknown>) => void;
type IncludeTarget = Extract<CursorTarget, { readonly kind: 'include' }>;
type MemberTarget = Extract<CursorTarget, { readonly kind: 'member' }>;
type DefinitionWord = Extract<CursorTarget, { readonly kind: 'symbol' }>['word'];

/** Include jumps need only the immutable request text and include context. */
export function canNavigateDefinitionWithoutDocumentIndex(
  input: DefinitionAtInput,
  facts?: CursorRequestFacts,
): boolean {
  return (facts?.target() ?? cursorTargetAt(input.document.text, input.position)).kind === 'include';
}

/**
 * Workspace-owned Definition behavior. The LSP adapter supplies immutable
 * request data and logging observers; index composition remains private here.
 */
export async function navigateDefinition(
  state: WorkspaceNavigationState,
  input: DefinitionAtInput,
  facts?: CursorRequestFacts,
): Promise<LocationLink[] | null> {
  throwIfRequestCancelled(input.cancellation);
  const { document, position, observer } = input;
  const trace = (event: string, data: Record<string, unknown>): void => {
    if (state.definitionTrace) observer?.trace?.(event, data);
  };
  trace('request', {
    uri: document.uri,
    position,
    languageId: document.languageId,
  });

  const target = facts?.target() ?? cursorTargetAt(document.text, position);
  if (target.kind === 'include') {
    return navigateIncludeDefinition(state, input, target, trace);
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

  const shaderLabNameTarget = shaderLabNameTargetAt(index, position);
  if (shaderLabNameTarget) {
    return navigateShaderLabNameDefinition(state, shaderLabNameTarget);
  }

  // ShaderLab property -> HLSL declaration intentionally precedes the generic
  // HLSL lexical gate. Properties live outside HLSL blocks.
  const propertyHit = propertyAt(index, position);
  if (propertyHit) {
    return navigatePropertyDefinition(state, input, index, propertyHit, trace);
  }

  return navigateCodeDefinition(state, input, index, target, trace, facts);
}

async function navigateIncludeDefinition(
  state: WorkspaceNavigationState,
  input: DefinitionAtInput,
  target: IncludeTarget,
  trace: DefinitionTrace,
): Promise<LocationLink[] | null> {
  const { include } = target;
  const resolved = await awaitWithRequestCancellation(
    state.includeChain.resolve(include.path, input.document.uri),
    input.cancellation,
  );
  if (!resolved) return null;
  if (resolved.caseInsensitive) {
    input.observer?.caseInsensitiveInclude?.(include.path, resolved.absolutePath);
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
      start: {
        line: input.position.line,
        character: include.pathRange.start.character,
      },
      end: {
        line: input.position.line,
        character: include.pathRange.end.character,
      },
    },
  }];
}

function navigateShaderLabNameDefinition(
  state: WorkspaceNavigationState,
  target: ShaderLabNameTarget,
): LocationLink[] | null {
  const locations = shaderLabNameDefinitions(state, target);
  return locations.length > 0
    ? locations.map((location) => ({
      targetUri: location.uri,
      targetRange: location.range,
      targetSelectionRange: location.range,
      originSelectionRange: target.range,
    }))
    : null;
}

async function navigatePropertyDefinition(
  state: WorkspaceNavigationState,
  input: DefinitionAtInput,
  index: FileIndex,
  property: ShaderLabPropertyEntry,
  trace: DefinitionTrace,
): Promise<LocationLink[] | null> {
  trace('property.hit', { name: property.name });
  const visibleUriKeys = await awaitWithRequestCancellation(
    state.includeChain.visibleUriKeys(input.document.uri),
    input.cancellation,
  );
  const symbols = resolveDefinition(
    {
      kind: 'symbol',
      word: { text: property.name, range: property.nameRange },
    },
    {
      index,
      global: state.index.global,
      position: input.position,
      options: { visibleUriKeys, trace },
    },
  ).filter((symbol) => symbol.kind === 'variable' || symbol.kind === 'cbuffer');
  trace('property.forward', { links: symbols.length });
  return symbols.length > 0
    ? symbols.map((symbol) => symbolToLocationLink(symbol, property.nameRange))
    : null;
}

async function navigateCodeDefinition(
  state: WorkspaceNavigationState,
  input: DefinitionAtInput,
  index: FileIndex,
  target: Exclude<CursorTarget, IncludeTarget>,
  trace: DefinitionTrace,
  facts?: CursorRequestFacts,
): Promise<LocationLink[] | null> {
  const { document, position } = input;

  const genericContext = facts
    ? isGenericDefinitionCursor(facts.cursor)
    : isGenericDefinitionContext(
      document.text,
      position,
      document.languageId,
      document.uri,
    );
  if (!genericContext) {
    trace('context.rejected', {});
    return null;
  }

  const visibleUriKeys = await awaitWithRequestCancellation(
    state.includeChain.visibleUriKeys(document.uri),
    input.cancellation,
  );
  const resolverContext: ResolverContext = {
    index,
    global: state.index.global,
    position,
    options: { visibleUriKeys, trace },
    variantContext: variantContextStore.get(document.uri) ?? undefined,
    getText: (uri: string) => (uri === document.uri ? document.text : undefined),
    isShaderLab: isShaderLabUri(document.uri),
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
    const memberLinks = navigateMemberDefinition(target, resolverContext, trace);
    if (memberLinks) return memberLinks;
  }

  return navigateSymbolDefinition(state, memberToken, resolverContext, trace);
}

function navigateMemberDefinition(
  target: MemberTarget,
  context: ResolverContext,
  trace: DefinitionTrace,
): LocationLink[] | undefined {
  const symbols = resolveDefinition(target, context);
  trace('member.result', { links: symbols.length });
  return symbols.length > 0
    ? symbols.map((symbol) => symbolToLocationLink(symbol, target.member.range))
    : undefined;
}

function navigateSymbolDefinition(
  state: WorkspaceNavigationState,
  word: DefinitionWord,
  context: ResolverContext,
  trace: DefinitionTrace,
): LocationLink[] | null {
  trace('word', { text: word.text, range: word.range });
  const symbols = resolveDefinition({ kind: 'symbol', word }, context);

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
  const hlslLinks = symbols.map((symbol) => symbolToLocationLink(symbol, word.range));
  return [...hlslLinks, ...propertyLinks];
}

/** Workspace-owned Find References behavior. */
export async function navigateReferences(
  state: WorkspaceNavigationState,
  input: ReferencesAtInput,
  facts?: CursorRequestFacts,
): Promise<Location[] | null> {
  throwIfRequestCancelled(input.cancellation);
  const { document, position } = input;
  const target = facts?.target() ?? cursorTargetAt(document.text, position);
  if (target.kind === 'include') {
    const resolved = await awaitWithRequestCancellation(
      state.includeChain.resolve(target.include.path, document.uri),
      input.cancellation,
    );
    if (!resolved) return null;

    const targetUri = pathToFileURL(resolved.absolutePath).href;
    const locations: Location[] = [];
    let processed = 0;
    for (const uri of state.index.store.uris()) {
      const uriCheckpoint = cooperativeRequestCheckpoint(++processed, input.cancellation);
      if (uriCheckpoint) await uriCheckpoint;
      const index = state.index.store.get(uri);
      if (!index) continue;

      for (const reference of index.references) {
        const checkpoint = cooperativeRequestCheckpoint(++processed, input.cancellation);
        if (checkpoint) await checkpoint;
        if (reference.context !== 'include') continue;
        if (!state.includePackages && state.isInPackages(reference.location.uri)) continue;

        const candidate = await awaitWithRequestCancellation(
          state.includeChain.resolve(
            reference.name,
            reference.location.uri,
          ),
          input.cancellation,
        );
        if (!candidate) continue;
        if (pathToFileURL(candidate.absolutePath).href !== targetUri) continue;
        locations.push({
          uri: reference.location.uri,
          range: reference.location.range,
        });
      }
    }
    throwIfRequestCancelled(input.cancellation);
    return uniqueLocations(locations);
  }

  const index = state.index.store.get(document.uri);
  if (index) {
    const shaderLabNameTarget = shaderLabNameTargetAt(index, position);
    if (shaderLabNameTarget) {
      throwIfRequestCancelled(input.cancellation);
      if (shaderLabNameDefinitions(state, shaderLabNameTarget).length === 0) return null;
      const locations = shaderLabNameReferences(
        state,
        shaderLabNameTarget,
        input.includeDeclaration,
      );
      throwIfRequestCancelled(input.cancellation);
      return locations.length > 0 ? uniqueLocations(locations) : null;
    }
  }

  if (target.kind === 'none') return null;
  return findReferences(target, {
    index,
    position,
    global: state.index.global,
    globalRefs: state.index.globalRefs,
    store: state.index.store,
    includeChain: state.includeChain,
    isInPackages: state.isInPackages,
    includePackages: state.includePackages,
    includeDeclaration: input.includeDeclaration,
    cancellation: input.cancellation,
    variantContext: variantContextStore.get(document.uri) ?? undefined,
    getText: (uri: string) => (uri === document.uri ? document.text : undefined),
    isShaderLab: isShaderLabUri(document.uri),
  });
}
