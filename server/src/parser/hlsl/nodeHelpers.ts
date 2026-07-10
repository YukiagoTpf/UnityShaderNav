import type Parser from 'web-tree-sitter';
import type { Range } from '@unity-shader-nav/shared';

export function rangeOf(node: Parser.SyntaxNode): Range {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end:   { line: node.endPosition.row,   character: node.endPosition.column   },
  };
}

export function textOf(node: Parser.SyntaxNode | null | undefined): string {
  return node?.text ?? '';
}

export function* walk(root: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    yield n;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
}

export function firstChildOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) return c;
  }
  return undefined;
}
