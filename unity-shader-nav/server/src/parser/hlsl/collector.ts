import type Parser from 'web-tree-sitter';
import type {
  FileIndex,
  FunctionParameter,
  FunctionSymbolEntry,
  Range,
  ReferenceEntry,
  SymbolEntry,
  TypeInferenceEntry,
} from '@unity-shader-nav/shared';
import { rangeOf, textOf, walk } from './nodeHelpers';
import type { MacroPatternTable } from '../../macros';
import { matchDeclarationCall } from '../../macros/matcher';

interface CollectorState {
  uri: string;
  sourceText: string;
  /** Line offset to apply to all ranges (used when collecting HLSL block inside .shader). */
  lineOffset: number;
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
  typeInferences: TypeInferenceEntry[];
  /**
   * Node ids that the collector has consumed as a declaration site for a
   * symbol (function name, struct name, parameter name, ...). The reference
   * pass skips these so the declaration point isn't double-counted as a
   * reference. tree-sitter SyntaxNode does not expose a stable id directly,
   * so we key by startIndex + endIndex.
   */
  declarationSites: Set<string>;
}

function offsetRange(r: Range, delta: number): Range {
  if (delta === 0) return r;
  return {
    start: { line: r.start.line + delta, character: r.start.character },
    end:   { line: r.end.line   + delta, character: r.end.character   },
  };
}

function siteKey(node: Parser.SyntaxNode): string {
  return `${node.startIndex}:${node.endIndex}`;
}

function markDecl(st: CollectorState, node: Parser.SyntaxNode | null | undefined): void {
  if (node) st.declarationSites.add(siteKey(node));
}

function markNamedDescendants(st: CollectorState, node: Parser.SyntaxNode): void {
  if (node.type === 'identifier' || node.type === 'type_identifier') {
    markDecl(st, node);
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) markNamedDescendants(st, child);
  }
}

function declaratorNameNode(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | undefined {
  if (!node) return undefined;
  if (node.type === 'identifier' || node.type === 'field_identifier') return node;
  const inner = node.childForFieldName('declarator');
  return declaratorNameNode(inner);
}

function declaratorNodes(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return node.childrenForFieldName('declarator');
}

function isFunctionDeclarator(node: Parser.SyntaxNode | null | undefined): boolean {
  if (!node) return false;
  if (node.type === 'function_declarator') return true;
  return isFunctionDeclarator(node.childForFieldName('declarator'));
}

/**
 * Extract the function-name identifier from a `function_definition` node.
 * Path: function_definition.declarator (function_declarator).declarator (identifier).
 * For grammar-mis-parsed cbuffer/tbuffer the declarator is itself an identifier.
 */
function functionNameNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const decl = node.childForFieldName('declarator');
  if (!decl) return undefined;
  if (decl.type === 'function_declarator') {
    const inner = decl.childForFieldName('declarator');
    return inner ?? undefined;
  }
  if (decl.type === 'identifier') return decl;
  return undefined;
}

/** Collect parameters from a function_declarator. */
function collectParameters(
  fnDeclarator: Parser.SyntaxNode | null,
  st: CollectorState,
): FunctionParameter[] {
  if (!fnDeclarator) return [];
  const paramList = fnDeclarator.childForFieldName('parameters');
  if (!paramList) return [];
  const out: FunctionParameter[] = [];
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const p = paramList.namedChild(i);
    if (!p || p.type !== 'parameter_declaration') continue;
    const typeNode = p.childForFieldName('type');
    const nameNode = declaratorNameNode(p.childForFieldName('declarator'));
    if (!nameNode) continue;
    markDecl(st, nameNode);
    out.push({
      name: textOf(nameNode),
      type: textOf(typeNode),
      range: offsetRange(rangeOf(nameNode), st.lineOffset),
    });
  }
  return out;
}

function isCbufferShape(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'function_definition') return false;
  const typeNode = node.childForFieldName('type');
  const declarator = node.childForFieldName('declarator');
  if (!typeNode || !declarator) return false;
  const t = textOf(typeNode);
  // Grammar mis-parses `cbuffer/tbuffer Name { ... };` as a C function.
  // Signature: type is a bare identifier 'cbuffer'/'tbuffer'/'ConstantBuffer',
  // and the declarator is itself an identifier (not a function_declarator,
  // which would imply parameters).
  if (t !== 'cbuffer' && t !== 'tbuffer' && t !== 'ConstantBuffer') return false;
  return declarator.type === 'identifier';
}

function collectCbufferShape(node: Parser.SyntaxNode, st: CollectorState): void {
  const nameNode = node.childForFieldName('declarator');
  if (!nameNode) return;
  markDecl(st, nameNode);
  st.symbols.push({
    name: textOf(nameNode),
    kind: 'cbuffer',
    location: { uri: st.uri, range: offsetRange(rangeOf(nameNode), st.lineOffset) },
  });
  const body = node.childForFieldName('body');
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i);
    if (!stmt || stmt.type !== 'declaration') continue;
    const typeNode = stmt.childForFieldName('type');
    for (const declNode of declaratorNodes(stmt)) {
      const idNode = declaratorNameNode(declNode);
      if (!idNode) continue;
      markDecl(st, idNode);
      st.symbols.push({
        name: textOf(idNode),
        kind: 'variable',
        declaredType: textOf(typeNode),
        location: { uri: st.uri, range: offsetRange(rangeOf(idNode), st.lineOffset) },
      });
    }
  }
}

function collectGlobalDeclaration(node: Parser.SyntaxNode, st: CollectorState): void {
  if (node.parent?.type !== 'translation_unit') return;
  const typeNode = node.childForFieldName('type');
  for (const declNode of declaratorNodes(node)) {
    if (isFunctionDeclarator(declNode)) continue;
    const idNode = declaratorNameNode(declNode);
    if (!idNode) continue;
    markDecl(st, idNode);
    st.symbols.push({
      name: textOf(idNode),
      kind: 'variable',
      declaredType: textOf(typeNode),
      location: { uri: st.uri, range: offsetRange(rangeOf(idNode), st.lineOffset) },
    });
  }
}

function collectFunction(node: Parser.SyntaxNode, st: CollectorState): void {
  if (isCbufferShape(node)) {
    collectCbufferShape(node, st);
    return;
  }

  const nameNode = functionNameNode(node);
  if (!nameNode) return;
  const typeNode = node.childForFieldName('type');
  const fnDeclarator = node.childForFieldName('declarator');

  markDecl(st, nameNode);
  const parameters = collectParameters(
    fnDeclarator?.type === 'function_declarator' ? fnDeclarator : null,
    st,
  );

  const bodyNode = node.childForFieldName('body');
  const scopeRange = bodyNode
    ? offsetRange(rangeOf(bodyNode), st.lineOffset)
    : undefined;

  const fnName = textOf(nameNode);
  const entry: FunctionSymbolEntry = {
    name: fnName,
    kind: 'function',
    location: { uri: st.uri, range: offsetRange(rangeOf(nameNode), st.lineOffset) },
    returnType: textOf(typeNode),
    parameters,
  };
  if (scopeRange) entry.scopeRange = scopeRange;
  st.symbols.push(entry);

  for (const p of parameters) {
    const paramEntry: SymbolEntry = {
      name: p.name,
      kind: 'parameter',
      location: { uri: st.uri, range: p.range },
      scope: fnName,
      declaredType: p.type,
    };
    if (scopeRange) paramEntry.scopeRange = scopeRange;
    st.symbols.push(paramEntry);
  }

  if (bodyNode && scopeRange) {
    collectLocals(fnName, bodyNode, scopeRange, st);
  }
}

/**
 * Walk a function body looking for `declaration` nodes whose declarator
 * yields an identifier. Handles both `float k = expr;` (init_declarator wrap)
 * and `Foo bar;` (declarator is identifier). Also handles `for (int i = ...)`
 * where the for_statement.initializer is a `declaration`.
 */
function collectLocals(
  fnName: string,
  bodyNode: Parser.SyntaxNode,
  scopeRange: Range,
  st: CollectorState,
): void {
  for (const n of walk(bodyNode)) {
    if (n.type === 'declaration') {
      const typeNode = n.childForFieldName('type');
      for (const declNode of declaratorNodes(n)) {
        const idNode = declaratorNameNode(declNode);
        if (!idNode) continue;
        markDecl(st, idNode);
        st.symbols.push({
          name: textOf(idNode),
          kind: 'localVariable',
          location: { uri: st.uri, range: offsetRange(rangeOf(idNode), st.lineOffset) },
          scope: fnName,
          scopeRange,
          declaredType: textOf(typeNode),
        });
      }
    } else if (n.type === 'assignment_expression') {
      collectTypeInference(fnName, scopeRange, n, st);
    }
  }
}

function collectTypeInference(
  fnName: string,
  scopeRange: Range,
  node: Parser.SyntaxNode,
  st: CollectorState,
): void {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right || left.type !== 'identifier' || right.type !== 'call_expression') return;

  const callee = right.childForFieldName('function');
  if (!callee || callee.type !== 'identifier') return;

  st.typeInferences.push({
    receiver: textOf(left),
    callName: textOf(callee),
    assignmentRange: offsetRange(rangeOf(node), st.lineOffset),
    scope: fnName,
    scopeRange,
  });
}

function collectStruct(node: Parser.SyntaxNode, st: CollectorState): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  markDecl(st, nameNode);
  const structName = textOf(nameNode);

  st.symbols.push({
    name: structName,
    kind: 'struct',
    location: { uri: st.uri, range: offsetRange(rangeOf(nameNode), st.lineOffset) },
  });

  const body = node.childForFieldName('body');
  if (!body) return;
  const textualEnd = st.sourceText.indexOf('};', body.startIndex);
  const bodyEndIndex = textualEnd >= 0 && textualEnd < body.endIndex ? textualEnd : body.endIndex;
  for (let i = 0; i < body.namedChildCount; i++) {
    const field = body.namedChild(i);
    if (!field || field.type !== 'field_declaration') continue;
    if (field.startIndex >= bodyEndIndex) continue;
    const typeNode = field.childForFieldName('type');
    for (const declNode of declaratorNodes(field)) {
      const fidNode = declaratorNameNode(declNode);
      if (!fidNode) continue;
      markDecl(st, fidNode);
      st.symbols.push({
        name: textOf(fidNode),
        kind: 'structMember',
        parentType: structName,
        declaredType: textOf(typeNode),
        location: { uri: st.uri, range: offsetRange(rangeOf(fidNode), st.lineOffset) },
      });
    }
  }
}

function collectMacroDeclaration(
  node: Parser.SyntaxNode,
  st: CollectorState,
  table: MacroPatternTable | undefined,
): void {
  if (!table || node.type !== 'call_expression') return;
  const match = matchDeclarationCall(node, table);
  if (!match) return;
  markNamedDescendants(st, node);
  st.symbols.push({
    name: match.capturedName,
    kind: match.symbolKind,
    location: { uri: st.uri, range: offsetRange(match.nameRange, st.lineOffset) },
  });
}

function receiverExpression(node: Parser.SyntaxNode): string | undefined {
  const receiver =
    node.childForFieldName('argument') ??
    node.childForFieldName('object') ??
    node.namedChild(0);
  if (
    !receiver ||
    (
      receiver.type !== 'identifier' &&
      receiver.type !== 'field_expression' &&
      receiver.type !== 'subscript_expression'
    )
  ) {
    return undefined;
  }
  return textOf(receiver);
}

function collectReferences(node: Parser.SyntaxNode, st: CollectorState): void {
  if (node.type === 'call_expression') {
    const callee = node.childForFieldName('function');
    if (callee) {
      let nameNode: Parser.SyntaxNode | null = null;
      if (callee.type === 'identifier') {
        nameNode = callee;
      } else if (callee.type === 'field_expression') {
        nameNode = callee.childForFieldName('field');
      }
      if (nameNode && !st.declarationSites.has(siteKey(nameNode))) {
        st.references.push({
          name: textOf(nameNode),
          location: { uri: st.uri, range: offsetRange(rangeOf(nameNode), st.lineOffset) },
          context: 'call',
        });
        // Mark so we don't also record it via the generic identifier branch.
        st.declarationSites.add(siteKey(nameNode));
      }
    }
  } else if (node.type === 'field_expression') {
    const fid = node.childForFieldName('field');
    if (fid && !st.declarationSites.has(siteKey(fid))) {
      st.references.push({
        name: textOf(fid),
        location: { uri: st.uri, range: offsetRange(rangeOf(fid), st.lineOffset) },
        context: 'member',
        receiver: receiverExpression(node),
      });
      st.declarationSites.add(siteKey(fid));
    }
  } else if (node.type === 'type_identifier') {
    if (!st.declarationSites.has(siteKey(node))) {
      st.references.push({
        name: textOf(node),
        location: { uri: st.uri, range: offsetRange(rangeOf(node), st.lineOffset) },
        context: 'type',
      });
    }
  } else if (node.type === 'identifier') {
    if (!st.declarationSites.has(siteKey(node))) {
      st.references.push({
        name: textOf(node),
        location: { uri: st.uri, range: offsetRange(rangeOf(node), st.lineOffset) },
        context: 'identifier',
      });
    }
  }
}

export function collect(
  root: Parser.SyntaxNode,
  text: string,
  uri: string,
  lineOffset: number,
  table?: MacroPatternTable,
): FileIndex {
  const st: CollectorState = {
    uri,
    sourceText: text,
    lineOffset,
    symbols: [],
    references: [],
    typeInferences: [],
    declarationSites: new Set(),
  };

  // First pass — collect declarations. Walk depth-first; cbuffer-shaped
  // function_definition nodes contain inner `declaration`s which we want to
  // attribute to the cbuffer, so handle them inside collectFunction.
  // We still walk the whole tree because struct definitions can be nested
  // inside other declarations and locals must be reachable as well.
  for (const node of walk(root)) {
    if (node.type === 'function_definition') {
      collectFunction(node, st);
    } else if (node.type === 'struct_specifier') {
      collectStruct(node, st);
    } else if (node.type === 'declaration') {
      collectGlobalDeclaration(node, st);
    } else if (node.type === 'call_expression') {
      collectMacroDeclaration(node, st, table);
    }
  }

  // Second pass — references. We re-walk so we can consult declarationSites
  // populated in pass 1.
  for (const node of walk(root)) {
    collectReferences(node, st);
  }

  const result: FileIndex = { uri, symbols: st.symbols, references: st.references };
  if (st.typeInferences.length > 0) result.typeInferences = st.typeInferences;
  return result;
}
