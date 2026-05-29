import {
  SymbolKind as LspSymbolKind,
  type Connection,
  type SymbolInformation,
  type WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import type { SymbolEntry } from '@unity-shader-nav/shared';
import { HIDDEN_SYMBOL_KINDS, SYMBOL_KIND_MAP } from '../index/symbolKindMap';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { Workspace, WorkspaceManager } from '../workspace';

const MAX_RESULTS = 1000;

function basenameFromUri(uri: string): string | undefined {
  const withoutQuery = uri.split('?', 1)[0].split('#', 1)[0];
  const lastSlash = withoutQuery.lastIndexOf('/');
  if (lastSlash === -1 || lastSlash === withoutQuery.length - 1) return undefined;
  try {
    return decodeURIComponent(withoutQuery.slice(lastSlash + 1));
  } catch {
    return withoutQuery.slice(lastSlash + 1);
  }
}

function containerNameFor(symbol: SymbolEntry): string | undefined {
  if (symbol.kind === 'structMember' && symbol.parentType) return symbol.parentType;
  return basenameFromUri(symbol.location.uri);
}

function compareEntries(a: SymbolEntry, b: SymbolEntry): number {
  return a.name.localeCompare(b.name)
    || a.location.uri.localeCompare(b.location.uri)
    || a.location.range.start.line - b.location.range.start.line
    || a.location.range.start.character - b.location.range.start.character;
}

function toSymbolInformation(symbol: SymbolEntry): SymbolInformation {
  return {
    name: symbol.name,
    kind: SYMBOL_KIND_MAP[symbol.kind] ?? LspSymbolKind.Object,
    location: symbol.location,
    containerName: containerNameFor(symbol),
  };
}

function* collectMatches(
  workspace: Pick<Workspace, 'global' | 'settings' | 'packages'>,
  needle: string,
): Iterable<SymbolEntry> {
  const includePackages = workspace.settings.findReferences.includePackages;
  for (const entry of workspace.global.entries()) {
    if (HIDDEN_SYMBOL_KINDS.has(entry.kind)) continue;
    if (entry.name.trim().length === 0) continue;
    if (!includePackages && workspace.packages.isInPackages(entry.location.uri)) continue;
    if (!entry.name.toLowerCase().includes(needle)) continue;
    yield entry;
  }
}

export function registerWorkspaceSymbolHandler(
  connection: Connection,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onWorkspaceSymbol(async (params: WorkspaceSymbolParams): Promise<SymbolInformation[] | null> => {
    const resolveRequest = async (): Promise<SymbolInformation[]> => {
      const needle = params.query.trim().toLowerCase();
      if (needle.length === 0) return [];

      const workspaces = await manager.readyList();
      const matches: SymbolEntry[] = [];
      for (const workspace of workspaces) {
        for (const entry of collectMatches(workspace, needle)) {
          matches.push(entry);
        }
      }

      matches.sort(compareEntries);
      const capped = matches.length > MAX_RESULTS ? matches.slice(0, MAX_RESULTS) : matches;
      return capped.map(toSymbolInformation);
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
