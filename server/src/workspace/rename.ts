import type {
  Range,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import type { SymbolEntry } from '@unity-shader-nav/shared';
import {
  cursorTargetAt,
  findPropertyCandidatesForName,
  findReferences,
  propertyAt,
  selectActiveReferenceTargets,
  type ActiveReferenceTargetSelection,
} from '../index';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import { findBuiltinEntries } from '../vocabulary';
import type {
  DocumentPositionInput,
  RenameEditOutcome,
  RenameFailure,
  RenamePreparationOutcome,
} from './indexedWorkspace';
import type { WorkspaceNavigationState } from './navigation';

type RenameTarget = ActiveReferenceTargetSelection['targets'][number];

interface RenameSubject {
  readonly cursorTarget: ReturnType<typeof cursorTargetAt>;
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
): Promise<RenameSubject | RenameFailure | null> {
  const { document, position } = input;
  const index = state.index.store.get(document.uri);
  if (!index) return null;

  if (propertyAt(index, position)) {
    return rejected('ShaderLab Property rename is not supported yet.');
  }

  const cursorTarget = cursorTargetAt(document.text, position);
  if (cursorTarget.kind === 'include') {
    return rejected('Include paths cannot be renamed as HLSL symbols.');
  }
  if (cursorTarget.kind === 'none') return null;
  if (!isGenericDefinitionContext(
    document.text,
    position,
    document.languageId,
    document.uri,
  )) return null;

  const token = cursorTarget.kind === 'member'
    ? cursorTarget.member
    : cursorTarget.word;
  const visibleUriKeys = await state.includeChain.visibleUriKeys(document.uri);
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

  return { cursorTarget, token, declaration };
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

  if (target.kind === 'structMember') {
    const collision = state.index.global.lookup(newName).some((symbol) => (
      symbol.kind === 'structMember'
      && symbol.parentType === target.parentType
      && !sameRange(symbol.location.range, target.range)
    ));
    return collision
      ? `New name '${newName}' already exists on struct '${target.parentType ?? '<unknown>'}'.`
      : undefined;
  }

  const collision = state.index.global.lookup(newName).some((symbol) => (
    !isScoped(symbol)
    && symbol.kind !== 'structMember'
    && !(
      symbol.location.uri === target.uri
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
): Promise<RenamePreparationOutcome> {
  const subject = await resolveRenameSubject(state, input);
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
): Promise<RenameEditOutcome> {
  const subject = await resolveRenameSubject(state, input);
  if (!isRenameSubject(subject)) return subject;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.newName)) {
    return rejected(`'${input.newName}' is not a valid HLSL identifier.`);
  }
  if (input.newName === subject.declaration.name) return null;

  const conflict = collisionReason(state, subject.declaration, input.newName);
  if (conflict) return rejected(conflict);

  const index = state.index.store.get(input.document.uri);
  if (!index) return null;
  const locations = await findReferences(subject.cursorTarget, {
    index,
    position: input.position,
    global: state.index.global,
    globalRefs: state.index.globalRefs,
    store: state.index.store,
    includeChain: state.includeChain,
    isInPackages: state.isInPackages,
    includePackages: false,
    includeDeclaration: true,
  });
  const editable = locations.filter((location) => !state.isInPackages(location.uri));
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
  const changes: NonNullable<WorkspaceEdit['changes']> = {};
  for (const location of editable) {
    (changes[location.uri] ??= []).push({
      range: location.range,
      newText: input.newName,
    });
  }
  return { changes };
}
