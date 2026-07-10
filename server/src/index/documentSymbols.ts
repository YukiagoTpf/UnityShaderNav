import {
  SymbolKind as LspSymbolKind,
  type DocumentSymbol,
} from 'vscode-languageserver/node';
import type {
  FileIndex,
  Range,
  ReferenceEntry,
  ShaderLabStructureNode,
  SymbolEntry,
} from '@unity-shader-nav/shared';
import { SYMBOL_KIND_MAP } from './symbolKindMap';

function rangeOfLines(startLine: number, endLine: number): Range {
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: 0 },
  };
}

function containsLine(range: Range, line: number): boolean {
  return line >= range.start.line && line <= range.end.line;
}

function containsRange(outer: Range, inner: Range): boolean {
  return containsLine(outer, inner.start.line) && containsLine(outer, inner.end.line);
}

function startsBefore(a: Range, b: Range): number {
  return a.start.line - b.start.line || a.start.character - b.start.character;
}

function hasSymbolName(symbol: SymbolEntry): boolean {
  return symbol.name.trim().length > 0;
}

function makeDocumentSymbol(
  name: string,
  kind: LspSymbolKind,
  range: Range,
  selectionRange: Range = range,
  children: DocumentSymbol[] = [],
): DocumentSymbol {
  return { name, kind, range, selectionRange, children };
}

function rangeWithChildren(range: Range, children: DocumentSymbol[]): Range {
  return children.reduce<Range>((expanded, child) => ({
    start: startsBefore(expanded, child.range) <= 0 ? expanded.start : child.range.start,
    end: (
      expanded.end.line > child.range.end.line
      || (expanded.end.line === child.range.end.line
        && expanded.end.character >= child.range.end.character)
    ) ? expanded.end : child.range.end,
  }), range);
}

function symbolToDocumentSymbol(symbol: SymbolEntry): DocumentSymbol {
  const children: DocumentSymbol[] = [];
  const range = symbol.scopeRange
    ? {
        start: symbol.location.range.start,
        end: symbol.scopeRange.end,
      }
    : symbol.location.range;
  return makeDocumentSymbol(
    symbol.name,
    SYMBOL_KIND_MAP[symbol.kind] ?? LspSymbolKind.Object,
    range,
    symbol.location.range,
    children,
  );
}

function pragmaToDocumentSymbol(reference: ReferenceEntry): DocumentSymbol {
  return makeDocumentSymbol(
    `#pragma ${reference.name}`,
    LspSymbolKind.Event,
    reference.location.range,
  );
}

function buildHlslSymbols(index: FileIndex): DocumentSymbol[] {
  const membersByStruct = new Map<SymbolEntry, SymbolEntry[]>();
  const topLevel: SymbolEntry[] = [];

  for (const symbol of index.symbols) {
    if (!hasSymbolName(symbol)) continue;
    if (symbol.kind === 'parameter' || symbol.kind === 'localVariable') continue;
    if (symbol.kind === 'structMember') continue;
    topLevel.push(symbol);
  }

  const structs = topLevel
    .filter((symbol) => symbol.kind === 'struct')
    .sort((a, b) => startsBefore(a.location.range, b.location.range));

  for (const symbol of index.symbols) {
    if (!hasSymbolName(symbol)) continue;
    if (symbol.kind !== 'structMember' || !symbol.parentType) continue;
    const parent = [...structs].reverse().find((candidate) =>
      candidate.name === symbol.parentType
      && startsBefore(candidate.location.range, symbol.location.range) <= 0,
    );
    if (!parent) continue;

    const members = membersByStruct.get(parent) ?? [];
    members.push(symbol);
    membersByStruct.set(parent, members);
  }

  const docs = topLevel.map((symbol) => {
    const doc = symbolToDocumentSymbol(symbol);
    if (symbol.kind === 'struct') {
      doc.children = (membersByStruct.get(symbol) ?? [])
        .sort((a, b) => startsBefore(a.location.range, b.location.range))
        .map(symbolToDocumentSymbol);
      doc.range = rangeWithChildren(doc.range, doc.children);
    }
    return doc;
  });

  for (const reference of index.references) {
    if (reference.context === 'pragma') docs.push(pragmaToDocumentSymbol(reference));
  }

  return docs.sort((a, b) => startsBefore(a.range, b.range));
}

function nodeName(node: ShaderLabStructureNode): string {
  if (node.kind === 'shader') return `Shader "${node.name ?? ''}"`;
  if (node.kind === 'pass') return `Pass "${node.name ?? ''}"`;
  return 'SubShader';
}

function nodeKind(node: ShaderLabStructureNode): LspSymbolKind {
  if (node.kind === 'shader') return LspSymbolKind.Class;
  return LspSymbolKind.Module;
}

function buildStructureNode(
  node: ShaderLabStructureNode,
  hlslSymbols: DocumentSymbol[],
): DocumentSymbol {
  const range = rangeOfLines(node.headerLine, node.closeLine);
  const childRanges = node.children.map((child) => rangeOfLines(child.headerLine, child.closeLine));
  const structureChildren = node.children.map((child) => buildStructureNode(child, hlslSymbols));
  const ownHlslChildren = hlslSymbols.filter((symbol) =>
    containsRange(range, symbol.range)
    && !childRanges.some((childRange) => containsRange(childRange, symbol.range)),
  );

  return makeDocumentSymbol(
    nodeName(node),
    nodeKind(node),
    range,
    rangeOfLines(node.headerLine, node.headerLine),
    [...structureChildren, ...ownHlslChildren].sort((a, b) => startsBefore(a.range, b.range)),
  );
}

export function buildDocumentSymbols(index: FileIndex): DocumentSymbol[] {
  const hlslSymbols = buildHlslSymbols(index);
  if (!index.structure) return hlslSymbols;

  const shaderSymbols = index.structure.shaders.map((shader) =>
    buildStructureNode(shader, hlslSymbols),
  );
  const shaderRanges = index.structure.shaders.map((shader) =>
    rangeOfLines(shader.headerLine, shader.closeLine),
  );
  const outsideStructure = hlslSymbols.filter((symbol) =>
    !shaderRanges.some((range) => containsRange(range, symbol.range)),
  );

  return [...shaderSymbols, ...outsideStructure].sort((a, b) => startsBefore(a.range, b.range));
}
