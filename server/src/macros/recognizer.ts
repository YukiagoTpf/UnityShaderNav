import { createHash } from 'node:crypto';
import type Parser from 'web-tree-sitter';
import type {
  DeclarationMacroKind,
  Range,
  UserDeclarationMacro,
} from '@unity-shader-nav/shared';
import { exactSource, type ExactSource } from '../sourceLocation';
import { maskCommentsLine } from '../parser/masking';
import { rangeOf, textOf } from '../parser/hlsl/nodeHelpers';
import {
  BUILTIN_DECLARATION_MACROS,
  BUILTIN_REFERENCE_MACROS,
  BUILTIN_SENTINEL_MACROS,
} from './builtin';

interface CompiledCallPattern {
  readonly head: string;
  readonly parameterCount: number;
  readonly captureIndex: number;
}

interface CompiledDeclarationPattern extends CompiledCallPattern {
  readonly symbolKind: DeclarationMacroKind;
}

export interface DeclarationMacroMatch {
  readonly symbolKind: DeclarationMacroKind;
  readonly capturedName: string;
  readonly nameRange: Range;
}

export interface ReferencePatternMatch {
  readonly capturedName: string;
  readonly nameRange: Range;
}

export interface MacroPatternRecognizerOptions {
  readonly reportDiagnostic?: (message: string) => void;
}

const PARAM_RE = /^\s*(?:\$(\w+)|_)\s*$/;
const BUILTIN_DECLARATION_HEADS = new Set(
  BUILTIN_DECLARATION_MACROS
    .filter((macro) => macro.kind !== 'function-reference')
    .map((macro) => compileCallPattern(macro.pattern).head),
);

/**
 * Owns declaration/reference pattern compilation, lookup, capture matching,
 * structural sentinels, and the built-in lexical projection.
 */
export class MacroPatternRecognizer {
  private readonly declarationsByHead = new Map<string, CompiledDeclarationPattern[]>();
  private readonly referenceHeads = new Set<string>();
  private readonly sentinelHeads = new Set<string>(BUILTIN_SENTINEL_MACROS);
  private readonly reportDiagnostic: (message: string) => void;

  constructor(
    userMacros: readonly UserDeclarationMacro[] = [],
    options: MacroPatternRecognizerOptions = {},
  ) {
    this.reportDiagnostic = options.reportDiagnostic ?? ((message) => console.warn(message));
    for (const macro of BUILTIN_DECLARATION_MACROS) {
      if (macro.kind === 'function-reference') continue;
      this.addDeclaration(macro.pattern, macro.kind);
    }
    for (const macro of BUILTIN_REFERENCE_MACROS) {
      this.referenceHeads.add(compilePragmaPattern(macro.pattern));
    }
    for (const macro of userMacros) this.addUserDeclaration(macro);
  }

  matchDeclarationCall(callNode: Parser.SyntaxNode): DeclarationMacroMatch | null {
    const callee = callNode.childForFieldName('function') ?? callNode.namedChild(0);
    if (!callee || callee.type !== 'identifier') return null;
    const candidates = this.declarationsByHead.get(textOf(callee)) ?? [];
    if (candidates.length === 0) return null;

    const args = argumentNodes(callNode);
    for (const candidate of candidates) {
      if (candidate.parameterCount !== args.length) continue;
      const argument = args[candidate.captureIndex];
      const nameNode = argument?.type === 'identifier'
        ? argument
        : argument ? firstNamedDescendantOfType(argument, 'identifier') : undefined;
      if (!nameNode) continue;
      return {
        symbolKind: candidate.symbolKind,
        capturedName: textOf(nameNode),
        nameRange: rangeOf(nameNode),
      };
    }
    return null;
  }

  scanReferencePatterns(text: string | ExactSource): ReferencePatternMatch[] {
    const matches: ReferencePatternMatch[] = [];
    const source = exactSource(
      typeof text === 'string' ? text : text.sourceText,
      typeof text === 'string' ? undefined : text,
    );
    const lines = source.sourceLines;
    let inBlockComment = false;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const stripped = maskCommentsLine(
        lines[lineNumber],
        inBlockComment,
        { strings: 'preserve' },
      );
      inBlockComment = stripped.inBlockComment;
      const match = this.matchReferenceLine(stripped.code, lineNumber);
      if (match) matches.push(match);
    }
    return matches;
  }

  isStructuralSentinel(identifier: string): boolean {
    return this.sentinelHeads.has(identifier);
  }

  private matchReferenceLine(
    line: string,
    lineNumber: number,
  ): ReferencePatternMatch | null {
    const text = line.replace(/\/\/.*$/, '');
    const match = /^\s*(#pragma\s+\S+)\s+(\S+)/.exec(text);
    if (!match || !this.referenceHeads.has(match[1])) return null;
    const capturedName = match[2];
    const startCharacter = text.indexOf(
      capturedName,
      match[0].length - capturedName.length,
    );
    return {
      capturedName,
      nameRange: {
        start: { line: lineNumber, character: startCharacter },
        end: { line: lineNumber, character: startCharacter + capturedName.length },
      },
    };
  }

  private addDeclaration(pattern: string, symbolKind: DeclarationMacroKind): void {
    const compiled = compileCallPattern(pattern);
    const declarations = this.declarationsByHead.get(compiled.head) ?? [];
    declarations.push({ ...compiled, symbolKind });
    this.declarationsByHead.set(compiled.head, declarations);
  }

  private addUserDeclaration(macro: UserDeclarationMacro): void {
    try {
      this.addDeclaration(macro.pattern, macro.kind);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.reportDiagnostic(
        `Skipping invalid unityShaderNav.declarationMacros entry "${macro.pattern}": ${reason}`,
      );
    }
  }
}

/** Narrow lexical fact; user-configured macro heads intentionally stay excluded. */
export function builtinDeclarationMacroLexicalRole(
  identifier: string,
): 'macro' | undefined {
  return BUILTIN_DECLARATION_HEADS.has(identifier) ? 'macro' : undefined;
}

/** Content identity for every built-in, sentinel, reference, and user pattern fact. */
export function macroPatternIdentity(
  userMacros: readonly UserDeclarationMacro[],
): string {
  const facts = [
    ...BUILTIN_DECLARATION_MACROS.map((macro) => ({
      pattern: macro.pattern,
      kind: macro.kind,
      source: 'builtin-declaration',
    })),
    ...BUILTIN_REFERENCE_MACROS.map((macro) => ({
      pattern: macro.pattern,
      kind: macro.kind,
      source: 'builtin-reference',
    })),
    ...BUILTIN_SENTINEL_MACROS.map((pattern) => ({
      pattern,
      kind: 'sentinel',
      source: 'builtin-sentinel',
    })),
    ...userMacros.map((macro) => ({
      pattern: macro.pattern,
      kind: macro.kind,
      source: 'user',
    })),
  ].sort((left, right) => (
    left.pattern.localeCompare(right.pattern)
    || left.kind.localeCompare(right.kind)
    || left.source.localeCompare(right.source)
  ));
  return createHash('sha1').update(JSON.stringify(facts)).digest('hex');
}

function compileCallPattern(source: string): CompiledCallPattern {
  const match = /^([A-Z_][A-Z0-9_]*)\s*\((.*)\)\s*$/.exec(source);
  if (!match) throw new Error(`malformed macro pattern: ${source}`);
  const parameters = match[2].trim().length === 0
    ? []
    : match[2].split(',').map((raw) => {
      const parameter = PARAM_RE.exec(raw);
      if (!parameter) throw new Error(`bad param ${raw} in ${source}`);
      return parameter[1] ? 'capture' as const : 'placeholder' as const;
    });
  const captureIndex = parameters.indexOf('capture');
  if (captureIndex < 0) throw new Error(`missing capture in ${source}`);
  return {
    head: match[1],
    parameterCount: parameters.length,
    captureIndex,
  };
}

function compilePragmaPattern(source: string): string {
  const match = /^#pragma\s+(\S+)\s+\$(\w+)\s*$/.exec(source);
  if (!match) throw new Error(`malformed pragma pattern: ${source}`);
  return `#pragma ${match[1]}`;
}

function firstNamedDescendantOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (!child) continue;
    const found = firstNamedDescendantOfType(child, type);
    if (found) return found;
  }
  return undefined;
}

function argumentNodes(callNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const argumentsNode = callNode.childForFieldName('arguments')
    ?? firstNamedDescendantOfType(callNode, 'argument_list');
  return argumentsNode?.namedChildren ?? [];
}
