import {
  CompletionItemKind,
  MarkupKind,
  SymbolKind,
  type CompletionItem,
  type Hover,
  type Location,
  type Position,
  type Range,
  type SymbolInformation,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import type {
  FileIndex,
  ShaderLabPassNameEntry,
  ShaderLabShaderNameEntry,
} from '@unity-shader-nav/shared';
import type {
  RenameEditOutcome,
  RenameFailure,
  RenamePreparationOutcome,
} from './indexedWorkspace';
import type { IndexStoreReader } from '../index';
import {
  containsPosition,
  exactSource,
  type ExactSource,
} from '../sourceLocation';
import { uriKey } from '../uriKey';

export type ShaderLabNameTarget =
  | { kind: 'shader'; name: string; range: Range }
  | { kind: 'pass'; shaderName: string; name: string; canonicalName: string; range: Range };

export interface ShaderLabNameState {
  readonly index: { readonly store: IndexStoreReader };
  readonly isInPackages: (uri: string) => boolean;
  readonly includePackages?: boolean;
}

export function shaderLabNameTargetAt(
  index: FileIndex,
  position: Position,
): ShaderLabNameTarget | null {
  const facts = index.shaderLabNames;
  if (!facts) return null;
  for (const shader of facts.shaders) {
    if (containsPosition(shader.nameRange, position)) {
      return { kind: 'shader', name: shader.name, range: shader.nameRange };
    }
  }
  for (const pass of facts.passes) {
    if (containsPosition(pass.nameRange, position)) {
      return {
        kind: 'pass',
        shaderName: pass.shaderName,
        name: pass.name,
        canonicalName: pass.canonicalName,
        range: pass.nameRange,
      };
    }
  }
  for (const reference of facts.references) {
    if (containsPosition(reference.shaderNameRange, position)) {
      return { kind: 'shader', name: reference.shaderName, range: reference.shaderNameRange };
    }
    if (reference.kind === 'usePass' && containsPosition(reference.passNameRange, position)) {
      return {
        kind: 'pass',
        shaderName: reference.shaderName,
        name: reference.passName,
        canonicalName: reference.canonicalPassName,
        range: reference.passNameRange,
      };
    }
  }
  return null;
}

interface NamedEntry<T> {
  readonly uri: string;
  readonly entry: T;
}

function shaderDeclarations(
  state: ShaderLabNameState,
  name: string,
): Array<NamedEntry<ShaderLabShaderNameEntry>> {
  const out: Array<NamedEntry<ShaderLabShaderNameEntry>> = [];
  for (const uri of state.index.store.uris()) {
    const index = state.index.store.get(uri);
    for (const entry of index?.shaderLabNames?.shaders ?? []) {
      if (entry.name === name) out.push({ uri: index!.uri, entry });
    }
  }
  return out;
}

function passDeclarations(
  state: ShaderLabNameState,
  shaderName: string,
  canonicalName: string,
): Array<NamedEntry<ShaderLabPassNameEntry>> {
  const out: Array<NamedEntry<ShaderLabPassNameEntry>> = [];
  for (const uri of state.index.store.uris()) {
    const index = state.index.store.get(uri);
    for (const entry of index?.shaderLabNames?.passes ?? []) {
      if (entry.shaderName === shaderName && entry.canonicalName === canonicalName) {
        out.push({ uri: index!.uri, entry });
      }
    }
  }
  return out;
}

export function shaderLabNameDefinitions(
  state: ShaderLabNameState,
  target: ShaderLabNameTarget,
): Location[] {
  return target.kind === 'shader'
    ? shaderDeclarations(state, target.name).map(({ uri, entry }) => ({
      uri,
      range: entry.nameRange,
    }))
    : passDeclarations(state, target.shaderName, target.canonicalName)
      .map(({ uri, entry }) => ({ uri, range: entry.nameRange }));
}

export function shaderLabNameReferences(
  state: ShaderLabNameState,
  target: ShaderLabNameTarget,
  includeDeclaration: boolean,
): Location[] {
  const locations = includeDeclaration
    ? shaderLabNameDefinitions(state, target).filter((location) => (
      state.includePackages || !state.isInPackages(location.uri)
    ))
    : [];
  for (const uri of state.index.store.uris()) {
    const index = state.index.store.get(uri);
    if (!index || (!state.includePackages && state.isInPackages(index.uri))) continue;
    for (const reference of index.shaderLabNames?.references ?? []) {
      if (target.kind === 'shader') {
        if (reference.shaderName === target.name) {
          locations.push({ uri: index.uri, range: reference.shaderNameRange });
        }
      } else if (
        reference.kind === 'usePass'
        && reference.shaderName === target.shaderName
        && reference.canonicalPassName === target.canonicalName
      ) {
        locations.push({ uri: index.uri, range: reference.passNameRange });
      }
    }
  }
  return locations.sort((left, right) => (
    left.uri.localeCompare(right.uri)
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
  ));
}

export function shaderLabNameHover(target: ShaderLabNameTarget): Hover {
  return target.kind === 'shader'
    ? {
      contents: { kind: MarkupKind.Markdown, value: `\`Shader "${target.name}"\`` },
      range: target.range,
    }
    : {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`Pass "${target.name}"\`\n\nShader: \`${target.shaderName}\``,
      },
      range: target.range,
    };
}

interface NameCompletionContext {
  kind: 'fallback' | 'usePassShader' | 'usePassPass';
  prefix: string;
  shaderName?: string;
  replaceRange: Range;
}

export function shaderLabNameCompletionContext(
  text: string | ExactSource,
  position: Position,
): NameCompletionContext | null {
  const source = exactSource(
    typeof text === 'string' ? text : text.sourceText,
    typeof text === 'string' ? undefined : text,
  );
  const line = source.sourceLines[position.line] ?? '';
  const before = line.slice(0, position.character);
  const fallback = /^\s*Fallback\s+"([^"]*)$/.exec(before);
  if (fallback) {
    return {
      kind: 'fallback',
      prefix: fallback[1],
      replaceRange: {
        start: { line: position.line, character: position.character - fallback[1].length },
        end: position,
      },
    };
  }
  const usePass = /^\s*UsePass\s+"([^"]*)$/.exec(before);
  if (!usePass) return null;
  const value = usePass[1];
  const slash = value.lastIndexOf('/');
  if (slash < 0) {
    return {
      kind: 'usePassShader',
      prefix: value,
      replaceRange: {
        start: { line: position.line, character: position.character - value.length },
        end: position,
      },
    };
  }
  const passPrefix = value.slice(slash + 1);
  return {
    kind: 'usePassPass',
    shaderName: value.slice(0, slash),
    prefix: passPrefix,
    replaceRange: {
      start: { line: position.line, character: position.character - passPrefix.length },
      end: position,
    },
  };
}

export function completeShaderLabName(
  state: ShaderLabNameState,
  text: string | ExactSource,
  position: Position,
): CompletionItem[] | null {
  const context = shaderLabNameCompletionContext(text, position);
  if (!context) return null;
  if (context.kind === 'usePassPass') {
    const names = new Set<string>();
    for (const uri of state.index.store.uris()) {
      const index = state.index.store.get(uri);
      if (!index || (!state.includePackages && state.isInPackages(index.uri))) continue;
      for (const pass of index.shaderLabNames?.passes ?? []) {
        if (pass.shaderName === context.shaderName) names.add(pass.canonicalName);
      }
    }
    return [...names]
      .filter((name) => name.startsWith(context.prefix.toUpperCase()))
      .sort()
      .map((name): CompletionItem => ({
        label: name,
        kind: CompletionItemKind.Method,
        detail: `Pass in ${context.shaderName}`,
        textEdit: { range: context.replaceRange, newText: name },
      }));
  }
  const names = new Set<string>();
  for (const uri of state.index.store.uris()) {
    const index = state.index.store.get(uri);
    if (!index || (!state.includePackages && state.isInPackages(index.uri))) continue;
    for (const shader of index.shaderLabNames?.shaders ?? []) names.add(shader.name);
  }
  return [...names]
    .filter((name) => name.startsWith(context.prefix))
    .sort()
    .map((name): CompletionItem => ({
      label: context.kind === 'usePassShader' ? `${name}/` : name,
      kind: CompletionItemKind.Class,
      detail: 'ShaderLab Shader',
      textEdit: {
        range: context.replaceRange,
        newText: context.kind === 'usePassShader' ? `${name}/` : name,
      },
    }));
}

export function shaderLabWorkspaceSymbols(
  state: ShaderLabNameState,
  query: string,
): SymbolInformation[] {
  const needle = query.toLowerCase();
  const results: SymbolInformation[] = [];
  for (const uri of state.index.store.uris()) {
    const index = state.index.store.get(uri);
    if (!index || (!state.includePackages && state.isInPackages(index.uri))) continue;
    for (const shader of index.shaderLabNames?.shaders ?? []) {
      if (shader.name.toLowerCase().includes(needle)) results.push({
        name: shader.name,
        kind: SymbolKind.Class,
        location: { uri: index.uri, range: shader.nameRange },
        containerName: 'ShaderLab Shader',
      });
    }
    for (const pass of index.shaderLabNames?.passes ?? []) {
      if (pass.name.toLowerCase().includes(needle)) results.push({
        name: pass.name,
        kind: SymbolKind.Method,
        location: { uri: index.uri, range: pass.nameRange },
        containerName: pass.shaderName,
      });
    }
  }
  return results;
}

/** Cooperative variant used only by cancellable request paths. */
export async function shaderLabWorkspaceSymbolsCooperatively(
  state: ShaderLabNameState,
  query: string,
  checkpoint: () => Promise<void> | undefined,
): Promise<SymbolInformation[]> {
  const needle = query.toLowerCase();
  const results: SymbolInformation[] = [];
  for (const uri of state.index.store.uris()) {
    const uriPending = checkpoint();
    if (uriPending) await uriPending;
    const index = state.index.store.get(uri);
    if (!index || (!state.includePackages && state.isInPackages(index.uri))) continue;
    for (const shader of index.shaderLabNames?.shaders ?? []) {
      const pending = checkpoint();
      if (pending) await pending;
      if (shader.name.toLowerCase().includes(needle)) results.push({
        name: shader.name,
        kind: SymbolKind.Class,
        location: { uri: index.uri, range: shader.nameRange },
        containerName: 'ShaderLab Shader',
      });
    }
    for (const pass of index.shaderLabNames?.passes ?? []) {
      const pending = checkpoint();
      if (pending) await pending;
      if (pass.name.toLowerCase().includes(needle)) results.push({
        name: pass.name,
        kind: SymbolKind.Method,
        location: { uri: index.uri, range: pass.nameRange },
        containerName: pass.shaderName,
      });
    }
  }
  return results;
}

function failure(message: string): RenameFailure {
  return { kind: 'failure', message };
}

export function prepareShaderLabNameRename(
  state: ShaderLabNameState,
  target: ShaderLabNameTarget,
): RenamePreparationOutcome {
  const definitions = shaderLabNameDefinitions(state, target);
  if (definitions.length === 0) return failure('The ShaderLab name has no indexed declaration.');
  if (definitions.length > 1) {
    return failure(`Rename is ambiguous: the ShaderLab name has ${definitions.length} declarations.`);
  }
  if (state.isInPackages(definitions[0].uri)) {
    return failure('ShaderLab names declared in Unity Packages are read-only.');
  }
  return { kind: 'ready', range: target.range, placeholder: target.name };
}

export function renameShaderLabName(
  state: ShaderLabNameState,
  target: ShaderLabNameTarget,
  newName: string,
): RenameEditOutcome {
  const prepared = prepareShaderLabNameRename(state, target);
  if (!prepared || prepared.kind === 'failure') return prepared;
  if (!newName.trim() || newName !== newName.trim() || /["\r\n]/.test(newName)) {
    return failure(`'${newName}' is not a valid ShaderLab name.`);
  }
  if (target.kind === 'pass' && newName.includes('/')) {
    return failure('Pass names cannot contain a slash.');
  }
  if (newName === target.name) return null;
  const existing = target.kind === 'shader'
    ? shaderDeclarations(state, newName)
    : passDeclarations(state, target.shaderName, newName.toUpperCase());
  const keepsCurrentIdentity = target.kind === 'shader'
    ? newName === target.name
    : newName.toUpperCase() === target.canonicalName;
  if (existing.length > 0 && !keepsCurrentIdentity) {
    return failure(`New name '${newName}' conflicts with an indexed ShaderLab declaration.`);
  }

  const definitions = shaderLabNameDefinitions(state, target);
  const locations = shaderLabNameReferences(state, target, true)
    .filter((location) => !state.isInPackages(location.uri));
  const changes: NonNullable<WorkspaceEdit['changes']> = {};
  for (const location of locations) {
    const newText = target.kind === 'pass'
      && !(definitions.some((definition) => (
        uriKey(definition.uri) === uriKey(location.uri)
        && definition.range.start.line === location.range.start.line
        && definition.range.start.character === location.range.start.character
      )))
      ? newName.toUpperCase()
      : newName;
    (changes[location.uri] ??= []).push({ range: location.range, newText });
  }
  return { changes };
}
