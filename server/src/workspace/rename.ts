import type {
  Location,
  Range,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import type {
  FileIndex,
  ShaderLabPropertyEntry,
  SymbolEntry,
} from '@unity-shader-nav/shared';
import {
  cursorTargetAt,
  findPropertyCandidatesForName,
  findReferencesForTarget,
  propertyAt,
  selectActiveReferenceTargets,
  uniqueLocations,
  type ActiveReferenceTargetSelection,
} from '../index';
import {
  isGenericDefinitionContext,
  isGenericDefinitionCursor,
} from '../parser/lexical/context';
import { findBuiltinEntries } from '../vocabulary';
import type {
  DocumentPositionInput,
  RenameEditOutcome,
  RenameFailure,
  RenamePreparationOutcome,
} from './indexedWorkspace';
import type { WorkspaceNavigationState } from './navigation';
import {
  prepareShaderLabNameRename,
  renameShaderLabName,
  shaderLabNameTargetAt,
} from './shaderLabNames';
import { uriKey } from '../uriKey';
import type { CursorRequestFacts } from './requestFacts';
import {
  awaitWithRequestCancellation,
  cooperativeRequestCheckpoint,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';

type RenameTarget = ActiveReferenceTargetSelection['targets'][number];

interface PropertyRenameBinding {
  readonly uri: string;
  readonly entry: ShaderLabPropertyEntry;
  readonly visibleUriKeys: ReadonlySet<string>;
}

type RenameSubject = {
  readonly token: { readonly text: string; readonly range: Range };
  readonly declaration: RenameTarget;
  readonly property?: undefined;
} | {
  readonly token: { readonly text: string; readonly range: Range };
  readonly declaration?: RenameTarget;
  readonly property: PropertyRenameBinding;
};

function rejected(message: string): RenameFailure {
  return { kind: 'failure', message };
}

function samePosition(
  left: Range['start'],
  right: Range['start'],
): boolean {
  return left.line === right.line && left.character === right.character;
}

function sameRange(left: Range, right: Range): boolean {
  return samePosition(left.start, right.start) && samePosition(left.end, right.end);
}

function isScoped(symbol: Pick<SymbolEntry, 'kind'>): boolean {
  return symbol.kind === 'parameter' || symbol.kind === 'localVariable';
}

function rangesOverlap(left: Range, right: Range): boolean {
  const before = (a: Range['start'], b: Range['start']): boolean => (
    a.line < b.line || (a.line === b.line && a.character <= b.character)
  );
  return before(left.start, right.end) && before(right.start, left.end);
}

function isPropertyDeclaration(symbol: SymbolEntry): boolean {
  return symbol.kind === 'variable' || symbol.kind === 'cbuffer';
}

function targetForSymbol(symbol: SymbolEntry): RenameTarget {
  const target: RenameTarget = {
    name: symbol.name,
    kind: symbol.kind,
    uri: symbol.location.uri,
    range: symbol.location.range,
  };
  if (symbol.scopeRange) target.scopeRange = symbol.scopeRange;
  if (symbol.parentType) target.parentType = symbol.parentType;
  return target;
}

function sameFileProperties(
  index: FileIndex,
  name: string,
): ShaderLabPropertyEntry[] {
  return (index.properties ?? []).filter((property) => property.name === name);
}

function sameFilePropertyDeclarations(
  index: FileIndex,
  name: string,
): RenameTarget[] {
  return index.symbols
    .filter((symbol) => symbol.name === name && isPropertyDeclaration(symbol))
    .map(targetForSymbol);
}

async function resolvePropertyRenameSubject(
  state: WorkspaceNavigationState,
  input: DocumentPositionInput,
  index: FileIndex,
  property: ShaderLabPropertyEntry,
): Promise<RenameSubject | RenameFailure> {
  if (state.isInPackages(index.uri)) {
    return rejected('Symbols declared in Unity Packages are read-only.');
  }

  const properties = sameFileProperties(index, property.name);
  if (properties.length > 1) {
    return rejected(
      `Rename is ambiguous: '${property.name}' has ${properties.length} ShaderLab Property declarations in this file.`,
    );
  }

  const declarations = sameFilePropertyDeclarations(index, property.name);
  if (declarations.length > 1) {
    return rejected(
      `Rename is ambiguous: '${property.name}' has ${declarations.length} HLSL/CG declarations in this shader.`,
    );
  }

  const visibleUriKeys = await awaitWithRequestCancellation(
    state.includeChain.visibleUriKeys(index.uri),
    input.cancellation,
  );
  const visibleExternalDeclarations = state.index.global.lookup(property.name).filter((symbol) => (
    isPropertyDeclaration(symbol)
    && uriKey(symbol.location.uri) !== uriKey(index.uri)
    && visibleUriKeys.has(uriKey(symbol.location.uri))
  ));
  if (visibleExternalDeclarations.length > 0) {
    if (declarations.length > 0) {
      return rejected(
        `Rename is ambiguous: '${property.name}' has both same-file and include-visible HLSL/CG declarations.`,
      );
    }
    return rejected(
      `HLSL/CG declaration '${property.name}' is outside this shader; cross-file Property rename is not supported.`,
    );
  }

  return {
    token: { text: property.name, range: property.nameRange },
    declaration: declarations[0],
    property: { uri: index.uri, entry: property, visibleUriKeys },
  };
}

async function resolveRenameSubject(
  state: WorkspaceNavigationState,
  input: DocumentPositionInput,
  facts?: CursorRequestFacts,
): Promise<RenameSubject | RenameFailure | null> {
  throwIfRequestCancelled(input.cancellation);
  const { document, position } = input;
  const index = state.index.store.get(document.uri);
  if (!index) return null;

  const property = propertyAt(index, position);
  if (property) {
    return resolvePropertyRenameSubject(state, input, index, property);
  }

  const cursorTarget = facts?.target() ?? cursorTargetAt(document.text, position);
  if (cursorTarget.kind === 'include') {
    return rejected('Include paths cannot be renamed as HLSL symbols.');
  }
  if (cursorTarget.kind === 'none') return null;
  const genericContext = facts
    ? isGenericDefinitionCursor(facts.cursor)
    : isGenericDefinitionContext(
      document.text,
      position,
      document.languageId,
      document.uri,
    );
  if (!genericContext) return null;

  const token = cursorTarget.kind === 'member'
    ? cursorTarget.member
    : cursorTarget.word;
  const visibleUriKeys = await awaitWithRequestCancellation(
    state.includeChain.visibleUriKeys(document.uri),
    input.cancellation,
  );
  const selection = selectActiveReferenceTargets(
    cursorTarget,
    index,
    position,
    state.index.global,
    { visibleUriKeys },
  );
  if (selection.targets.length === 0) {
    if (findBuiltinEntries(token.text).length > 0) {
      return rejected('Unity and HLSL built-in symbols cannot be renamed.');
    }
    return rejected(`No indexed declaration can be proven for '${token.text}'.`);
  }
  if (selection.targets.length > 1) {
    return rejected(
      `Rename is ambiguous: '${token.text}' resolves to ${selection.targets.length} declarations.`,
    );
  }

  const declaration = selection.targets[0];
  if (state.isInPackages(declaration.uri)) {
    return rejected('Symbols declared in Unity Packages are read-only.');
  }
  if (
    declaration.kind === 'variable' || declaration.kind === 'cbuffer'
  ) {
    const properties = sameFileProperties(index, declaration.name);
    if (properties.length > 1) {
      return rejected(
        `Rename is ambiguous: '${declaration.name}' has ${properties.length} ShaderLab Property declarations in this file.`,
      );
    }
    if (properties.length === 1) {
      if (uriKey(declaration.uri) !== uriKey(index.uri)) {
        return rejected(
          `HLSL/CG declaration '${declaration.name}' is outside this shader; cross-file Property rename is not supported.`,
        );
      }
      return {
        token,
        declaration,
        property: { uri: index.uri, entry: properties[0], visibleUriKeys },
      };
    }
    if (findPropertyCandidatesForName(declaration.name, state.index.store).length > 0) {
      return rejected(
        `HLSL symbol '${declaration.name}' may be linked to a ShaderLab Property outside this file; cross-file rename is not supported.`,
      );
    }
  }

  return { token, declaration };
}

function isRenameSubject(
  value: RenameSubject | RenameFailure | null,
): value is RenameSubject {
  return !!value && !('kind' in value);
}

function collisionReason(
  state: WorkspaceNavigationState,
  target: RenameTarget,
  newName: string,
): string | undefined {
  if (findBuiltinEntries(newName).length > 0) {
    return `New name '${newName}' conflicts with a known Unity or HLSL built-in.`;
  }

  if (isScoped(target)) {
    const index = state.index.store.get(target.uri);
    const scope = target.scopeRange;
    const collision = index?.symbols.find((symbol) => (
      symbol.name === newName
      && !sameRange(symbol.location.range, target.range)
      && !!scope
      && !!symbol.scopeRange
      && rangesOverlap(scope, symbol.scopeRange)
    ));
    return collision
      ? `New name '${newName}' conflicts with a visible local or parameter.`
      : undefined;
  }

  if (target.parentType) {
    const collision = state.index.global.lookup(newName).some((symbol) => (
      symbol.parentType === target.parentType
      && !sameRange(symbol.location.range, target.range)
    ));
    return collision
      ? `New name '${newName}' already exists on struct '${target.parentType ?? '<unknown>'}'.`
      : undefined;
  }

  const collision = state.index.global.lookup(newName).some((symbol) => (
    !isScoped(symbol)
    && !symbol.parentType
    && !(
      uriKey(symbol.location.uri) === uriKey(target.uri)
      && sameRange(symbol.location.range, target.range)
    )
  ));
  if (collision) return `New name '${newName}' conflicts with an indexed global symbol.`;

  if (
    (target.kind === 'variable' || target.kind === 'cbuffer')
    && findPropertyCandidatesForName(newName, state.index.store).length > 0
  ) {
    return `New name '${newName}' conflicts with an indexed ShaderLab Property.`;
  }
  return undefined;
}

function propertyContractCollisionReason(
  state: WorkspaceNavigationState,
  subject: RenameSubject & { readonly property: PropertyRenameBinding },
  newName: string,
): string | undefined {
  if (findBuiltinEntries(newName).length > 0) {
    return `New name '${newName}' conflicts with a known Unity or HLSL built-in.`;
  }

  const index = state.index.store.get(subject.property.uri);
  const symbolCollision = index?.symbols.some((symbol) => (
    symbol.name === newName
    && !isScoped(symbol)
    && !symbol.parentType
    && !(
      !!subject.declaration
      && sameRange(symbol.location.range, subject.declaration.range)
    )
  ));
  if (symbolCollision) {
    return `New name '${newName}' conflicts with an indexed global symbol in this shader.`;
  }

  const visibleExternalCollision = state.index.global.lookup(newName).some((symbol) => (
    !isScoped(symbol)
    && !symbol.parentType
    && uriKey(symbol.location.uri) !== uriKey(subject.property.uri)
    && subject.property.visibleUriKeys.has(uriKey(symbol.location.uri))
  ));
  if (visibleExternalCollision) {
    return `New name '${newName}' conflicts with an include-visible global symbol.`;
  }

  const propertyCollision = index?.properties?.some((property) => (
    property.name === newName
    && !sameRange(property.nameRange, subject.property.entry.nameRange)
  ));
  return propertyCollision
    ? `New name '${newName}' conflicts with a ShaderLab Property in this shader.`
    : undefined;
}

function hasProperty(
  subject: RenameSubject,
): subject is RenameSubject & { readonly property: PropertyRenameBinding } {
  return subject.property !== undefined;
}

export async function prepareWorkspaceRename(
  state: WorkspaceNavigationState,
  input: DocumentPositionInput,
  facts?: CursorRequestFacts,
): Promise<RenamePreparationOutcome> {
  throwIfRequestCancelled(input.cancellation);
  const index = state.index.store.get(input.document.uri);
  const shaderLabNameTarget = index
    ? shaderLabNameTargetAt(index, input.position)
    : null;
  if (shaderLabNameTarget) return prepareShaderLabNameRename(state, shaderLabNameTarget);
  const subject = await resolveRenameSubject(state, input, facts);
  if (!isRenameSubject(subject)) return subject;
  return {
    kind: 'ready',
    range: subject.token.range,
    placeholder: subject.token.text,
  };
}

export async function renameWorkspaceSymbol(
  state: WorkspaceNavigationState,
  input: DocumentPositionInput & { readonly newName: string },
  facts?: CursorRequestFacts,
): Promise<RenameEditOutcome> {
  throwIfRequestCancelled(input.cancellation);
  const shaderLabIndex = state.index.store.get(input.document.uri);
  const shaderLabNameTarget = shaderLabIndex
    ? shaderLabNameTargetAt(shaderLabIndex, input.position)
    : null;
  if (shaderLabNameTarget) {
    return renameShaderLabName(state, shaderLabNameTarget, input.newName);
  }
  const subject = await resolveRenameSubject(state, input, facts);
  if (!isRenameSubject(subject)) return subject;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.newName)) {
    return rejected(`'${input.newName}' is not a valid HLSL identifier.`);
  }
  if (input.newName === subject.token.text) return null;

  const conflict = hasProperty(subject)
    ? propertyContractCollisionReason(state, subject, input.newName)
    : subject.declaration
      ? collisionReason(state, subject.declaration, input.newName)
      : undefined;
  if (conflict) return rejected(conflict);

  const index = state.index.store.get(input.document.uri);
  if (!index) return null;
  const locations = subject.declaration
    ? await findReferencesForTarget(subject.declaration, {
      index,
      position: input.position,
      global: state.index.global,
      globalRefs: state.index.globalRefs,
      store: state.index.store,
      includeChain: state.includeChain,
      isInPackages: state.isInPackages,
      includePackages: false,
      includeDeclaration: true,
      cancellation: input.cancellation,
    })
    : [];
  if (subject.property) {
    locations.push({
      uri: subject.property.uri,
      range: subject.property.entry.nameRange,
    });
  }
  const editable: Location[] = [];
  let processed = 0;
  for (const location of locations) {
    const isSamePropertyFile = !subject.property
      || uriKey(location.uri) === uriKey(subject.property.uri);
    if (isSamePropertyFile && !state.isInPackages(location.uri)) editable.push(location);
    const checkpoint = cooperativeRequestCheckpoint(++processed, input.cancellation);
    if (checkpoint) await checkpoint;
  }
  const uniqueEditable = uniqueLocations(editable);
  if (uniqueEditable.length === 0) {
    return rejected(`No editable occurrences were found for '${subject.token.text}'.`);
  }

  uniqueEditable.sort((left, right) => (
    left.uri.localeCompare(right.uri)
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.range.end.line - right.range.end.line
    || left.range.end.character - right.range.end.character
  ));
  throwIfRequestCancelled(input.cancellation);
  const changes: NonNullable<WorkspaceEdit['changes']> = {};
  for (const location of uniqueEditable) {
    (changes[location.uri] ??= []).push({
      range: location.range,
      newText: input.newName,
    });
    const checkpoint = cooperativeRequestCheckpoint(++processed, input.cancellation);
    if (checkpoint) await checkpoint;
  }
  return { changes };
}
