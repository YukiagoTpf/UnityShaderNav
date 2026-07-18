import type {
  Location,
  Range,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import type { SymbolEntry } from '@unity-shader-nav/shared';
import {
  cursorTargetAt,
  findPropertyCandidatesForName,
  findReferencesForTarget,
  propertyAt,
  selectActiveReferenceTargets,
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

interface RenameSubject {
  readonly token: { readonly text: string; readonly range: Range };
  readonly declaration: RenameTarget;
}

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

async function resolveRenameSubject(
  state: WorkspaceNavigationState,
  input: DocumentPositionInput,
  facts?: CursorRequestFacts,
): Promise<RenameSubject | RenameFailure | null> {
  throwIfRequestCancelled(input.cancellation);
  const { document, position } = input;
  const index = state.index.store.get(document.uri);
  if (!index) return null;

  if (propertyAt(index, position)) {
    return rejected('ShaderLab Property rename is not supported yet.');
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
    (declaration.kind === 'variable' || declaration.kind === 'cbuffer')
    && findPropertyCandidatesForName(declaration.name, state.index.store).length > 0
  ) {
    return rejected(
      `HLSL symbol '${declaration.name}' is linked to a ShaderLab Property; cross-contract rename is not supported yet.`,
    );
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
  if (input.newName === subject.declaration.name) return null;

  const conflict = collisionReason(state, subject.declaration, input.newName);
  if (conflict) return rejected(conflict);

  const index = state.index.store.get(input.document.uri);
  if (!index) return null;
  const locations = await findReferencesForTarget(subject.declaration, {
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
  });
  const editable: Location[] = [];
  let processed = 0;
  for (const location of locations) {
    if (!state.isInPackages(location.uri)) editable.push(location);
    const checkpoint = cooperativeRequestCheckpoint(++processed, input.cancellation);
    if (checkpoint) await checkpoint;
  }
  if (editable.length === 0) {
    return rejected(`No editable occurrences were found for '${subject.declaration.name}'.`);
  }

  editable.sort((left, right) => (
    left.uri.localeCompare(right.uri)
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.range.end.line - right.range.end.line
    || left.range.end.character - right.range.end.character
  ));
  throwIfRequestCancelled(input.cancellation);
  const changes: NonNullable<WorkspaceEdit['changes']> = {};
  for (const location of editable) {
    (changes[location.uri] ??= []).push({
      range: location.range,
      newText: input.newName,
    });
    const checkpoint = cooperativeRequestCheckpoint(++processed, input.cancellation);
    if (checkpoint) await checkpoint;
  }
  return { changes };
}
