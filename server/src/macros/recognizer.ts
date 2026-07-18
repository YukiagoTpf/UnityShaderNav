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
  type BuiltinDeclaredTypeRecipe,
} from './builtin';

interface CompiledCallPattern {
  readonly head: string;
  readonly parameterCount: number;
  readonly captureIndex: number;
}

interface CompiledDeclarationPattern extends CompiledCallPattern {
  readonly symbolKind: DeclarationMacroKind;
  readonly declaredType?: string;
  readonly declaredTypeRecipe?: BuiltinDeclaredTypeRecipe;
}

export interface DeclarationMacroMatch {
  readonly symbolKind: DeclarationMacroKind;
  readonly capturedName: string;
  readonly nameRange: Range;
  readonly declaredType?: string;
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
      this.addDeclaration(
        macro.pattern,
        macro.kind,
        macro.declaredType,
        macro.declaredTypeRecipe,
      );
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
        declaredType: resolveDeclaredType(candidate, args),
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

  private addDeclaration(
    pattern: string,
    symbolKind: DeclarationMacroKind,
    declaredType?: string,
    declaredTypeRecipe?: BuiltinDeclaredTypeRecipe,
  ): void {
    const compiled = compileCallPattern(pattern);
    const declarations = this.declarationsByHead.get(compiled.head) ?? [];
    declarations.push({
      ...compiled,
      symbolKind,
      declaredType,
      declaredTypeRecipe,
    });
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
      declaredType: macro.declaredType,
      declaredTypeRecipe: macro.declaredTypeRecipe,
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

function resolveDeclaredType(
  pattern: CompiledDeclarationPattern,
  args: readonly Parser.SyntaxNode[],
): string | undefined {
  if (pattern.declaredType) return pattern.declaredType;
  const recipe = pattern.declaredTypeRecipe;
  if (!recipe) return undefined;
  const argument = args[recipe.argumentIndex];
  if (!argument || argument.type === 'ERROR') return undefined;
  const argumentType = parseTypeArgumentText(textOf(argument));
  if (!argumentType) return undefined;
  return recipe.kind === 'generic'
    ? `${recipe.baseType}<${argumentType}>`
    : argumentType;
}

type TypeArgumentToken =
  | { readonly kind: 'identifier' | 'integer'; readonly text: string }
  | { readonly kind: 'scope' | 'less' | 'greater' | 'comma' };

function parseTypeArgumentText(source: string): string | undefined {
  const tokens = tokenizeTypeArgument(source);
  if (!tokens || tokens.length === 0) return undefined;
  let index = 0;

  const parseNamedType = (): string | undefined => {
    const first = tokens[index];
    if (first?.kind !== 'identifier') return undefined;
    index++;
    let result = first.text;

    while (tokens[index]?.kind === 'scope') {
      const name = tokens[index + 1];
      if (name?.kind !== 'identifier') return undefined;
      result += `::${name.text}`;
      index += 2;
    }

    if (tokens[index]?.kind !== 'less') return result;
    index++;
    const arguments_: string[] = [];
    while (true) {
      const token = tokens[index];
      let argument: string | undefined;
      if (token?.kind === 'integer') {
        argument = token.text;
        index++;
      } else {
        argument = parseNamedType();
      }
      if (!argument) return undefined;
      arguments_.push(argument);
      if (tokens[index]?.kind === 'greater') break;
      if (tokens[index]?.kind !== 'comma') return undefined;
      index++;
    }
    if (tokens[index]?.kind !== 'greater') return undefined;
    index++;
    return `${result}<${arguments_.join(', ')}>`;
  };

  const parsed = parseNamedType();
  return parsed && index === tokens.length ? parsed : undefined;
}

function tokenizeTypeArgument(source: string): TypeArgumentToken[] | undefined {
  const uncommented = stripTypeArgumentComments(source);
  if (uncommented === undefined) return undefined;
  const tokens: TypeArgumentToken[] = [];
  for (let index = 0; index < uncommented.length;) {
    const character = uncommented[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(uncommented.slice(index));
    if (identifier) {
      tokens.push({ kind: 'identifier', text: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    const integer = /^\d+/.exec(uncommented.slice(index));
    if (integer) {
      tokens.push({ kind: 'integer', text: integer[0] });
      index += integer[0].length;
      continue;
    }
    if (uncommented.startsWith('::', index)) {
      tokens.push({ kind: 'scope' });
      index += 2;
      continue;
    }
    const punctuation = character === '<'
      ? 'less'
      : character === '>'
        ? 'greater'
        : character === ','
          ? 'comma'
          : undefined;
    if (!punctuation) return undefined;
    tokens.push({ kind: punctuation });
    index++;
  }
  return tokens;
}

function stripTypeArgumentComments(source: string): string | undefined {
  let result = '';
  for (let index = 0; index < source.length;) {
    if (source.startsWith('//', index)) {
      const lineEnd = source.indexOf('\n', index + 2);
      if (lineEnd < 0) break;
      result += ' ';
      index = lineEnd + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const commentEnd = source.indexOf('*/', index + 2);
      if (commentEnd < 0) return undefined;
      result += ' ';
      index = commentEnd + 2;
      continue;
    }
    result += source[index];
    index++;
  }
  return result;
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
  return argumentsNode?.namedChildren.filter((child) => child.type !== 'comment') ?? [];
}
