import type Parser from 'web-tree-sitter';
import type { Range } from '@unity-shader-nav/shared';
import type { MacroPatternTable } from './index';
import { rangeOf, textOf } from '../parser/hlsl/nodeHelpers';

export interface DeclarationMatch {
  symbolKind: 'variable' | 'cbuffer';
  capturedName: string;
  nameRange: Range;
}

export interface ReferenceMatch {
  capturedName: string;
  nameRange: Range;
}

function firstNamedDescendantOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const found = firstNamedDescendantOfType(child, type);
    if (found) return found;
  }
  return undefined;
}

function argumentNodes(callNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const args = callNode.childForFieldName('arguments')
    ?? firstNamedDescendantOfType(callNode, 'argument_list');
  return args?.namedChildren ?? [];
}

export function matchDeclarationCall(
  callNode: Parser.SyntaxNode,
  table: MacroPatternTable,
): DeclarationMatch | null {
  const callee = callNode.childForFieldName('function') ?? callNode.namedChild(0);
  if (!callee || callee.type !== 'identifier') return null;
  const candidates = table.findDecl(textOf(callee));
  if (candidates.length === 0) return null;

  const args = argumentNodes(callNode);
  for (const cand of candidates) {
    if (cand.pattern.params.length !== args.length) continue;
    const capturedIndex = cand.pattern.params.findIndex((param) => param.kind === 'capture');
    if (capturedIndex < 0) continue;

    const arg = args[capturedIndex];
    const nameNode = arg.type === 'identifier'
      ? arg
      : firstNamedDescendantOfType(arg, 'identifier');
    if (!nameNode) continue;

    return {
      symbolKind: cand.symbolKind,
      capturedName: textOf(nameNode),
      nameRange: rangeOf(nameNode),
    };
  }

  return null;
}

export function matchPragmaLine(
  line: string,
  lineNumber: number,
  table: MacroPatternTable,
): ReferenceMatch | null {
  const text = line.replace(/\/\/.*$/, '');
  const m = /^\s*(#pragma\s+\S+)\s+(\S+)/.exec(text);
  if (!m) return null;
  const head = m[1];
  if (table.findRef(head).length === 0) return null;

  const captured = m[2];
  const startChar = text.indexOf(captured, m[0].length - captured.length);
  return {
    capturedName: captured,
    nameRange: {
      start: { line: lineNumber, character: startChar },
      end: { line: lineNumber, character: startChar + captured.length },
    },
  };
}
