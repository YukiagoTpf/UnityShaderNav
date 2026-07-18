/**
 * Four-valued evaluation of the small subset of preprocessor conditions this
 * analyzer supports. Deliberately *not* a general C expression evaluator:
 * anything outside the supported grammar collapses to `UNKNOWN` (kept visible).
 *
 * `UNKNOWN` dominates `VARIANT` in the `and`/`or` tables: a branch
 * that *might* be active via an unknown/include macro must never be dimmed as
 * variant-only.
 */

export type CondValue = 'TRUE' | 'FALSE' | 'VARIANT' | 'UNKNOWN';

export interface MacroState {
  /** locally `#define`'d and still in effect */
  defined: ReadonlySet<string>;
  /** locally `#undef`'d and not since re-defined */
  undefed: ReadonlySet<string>;
  /** Unity variant keywords from `multi_compile*` / `shader_feature*` pragmas */
  variants: ReadonlySet<string>;
}

/** Which directive introduced this condition. */
export type CondKind = 'ifdef' | 'ifndef' | 'if' | 'elif';

/**
 * Resolve `defined(name)` against the macro state. Order matters — explicit
 * local state beats variant inference, which beats absence:
 *
 * - `defined`  → `TRUE`
 * - `undefed`  → `FALSE`  (local `#undef` is authoritative for the rest of flow)
 * - `variants` → `VARIANT`
 * - otherwise  → `UNKNOWN` (absence alone is never `FALSE` — could come from an include)
 */
export function evalDefined(name: string, state: MacroState): CondValue {
  if (state.defined.has(name)) return 'TRUE';
  if (state.undefed.has(name)) return 'FALSE';
  if (state.variants.has(name)) return 'VARIANT';
  return 'UNKNOWN';
}

function not(v: CondValue): CondValue {
  switch (v) {
    case 'TRUE':
      return 'FALSE';
    case 'FALSE':
      return 'TRUE';
    default:
      return v; // VARIANT, UNKNOWN unchanged
  }
}

function and(a: CondValue, b: CondValue): CondValue {
  if (a === 'FALSE' || b === 'FALSE') return 'FALSE'; // absorbing for AND
  if (a === 'UNKNOWN' || b === 'UNKNOWN') return 'UNKNOWN'; // can't decide ⇒ visible
  if (a === 'VARIANT' || b === 'VARIANT') return 'VARIANT'; // remaining operands TRUE
  return 'TRUE';
}

function or(a: CondValue, b: CondValue): CondValue {
  if (a === 'TRUE' || b === 'TRUE') return 'TRUE'; // absorbing for OR
  if (a === 'UNKNOWN' || b === 'UNKNOWN') return 'UNKNOWN'; // can't decide ⇒ visible
  if (a === 'VARIANT' || b === 'VARIANT') return 'VARIANT'; // remaining operands FALSE
  return 'FALSE';
}

type Token =
  | { kind: 'defined' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'not' }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'eq' }
  | { kind: 'ne' }
  | { kind: 'lt' }
  | { kind: 'le' }
  | { kind: 'gt' }
  | { kind: 'ge' }
  | { kind: 'integer'; value: bigint }
  | { kind: 'ident'; value: string };

/**
 * Tokenize on the supported set only. Returns `null` on any character outside
 * this set so callers fall back to `UNKNOWN` rather than guessing at C syntax
 * that this presentation-only evaluator does not model.
 */
function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = expr.length;

  while (i < n) {
    const c = expr[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (c === '&' && expr[i + 1] === '&') {
      tokens.push({ kind: 'and' });
      i += 2;
      continue;
    }
    if (c === '|' && expr[i + 1] === '|') {
      tokens.push({ kind: 'or' });
      i += 2;
      continue;
    }
    if (c === '=' && expr[i + 1] === '=') {
      tokens.push({ kind: 'eq' });
      i += 2;
      continue;
    }
    if (c === '!' && expr[i + 1] === '=') {
      tokens.push({ kind: 'ne' });
      i += 2;
      continue;
    }
    if (c === '<' && expr[i + 1] === '=') {
      tokens.push({ kind: 'le' });
      i += 2;
      continue;
    }
    if (c === '>' && expr[i + 1] === '=') {
      tokens.push({ kind: 'ge' });
      i += 2;
      continue;
    }
    if (c === '!') {
      tokens.push({ kind: 'not' });
      i++;
      continue;
    }
    if (c === '<') {
      tokens.push({ kind: 'lt' });
      i++;
      continue;
    }
    if (c === '>') {
      tokens.push({ kind: 'gt' });
      i++;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /\d/.test(expr[j])) j++;
      tokens.push({ kind: 'integer', value: BigInt(expr.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(expr[j])) j++;
      const word = expr.slice(i, j);
      tokens.push(word === 'defined' ? { kind: 'defined' } : { kind: 'ident', value: word });
      i = j;
      continue;
    }
    // Arithmetic, calls, bitwise operators, commas, and all other syntax stay unsupported.
    return null;
  }

  return tokens;
}

interface EvalValue {
  condition: CondValue;
  /** Exact integer value when proven; null for macros whose replacement value is unknown. */
  integer: bigint | null;
}

function conditionValue(condition: CondValue): EvalValue {
  return {
    condition,
    integer: condition === 'TRUE' ? 1n : condition === 'FALSE' ? 0n : null,
  };
}

function macroValue(name: string, state: MacroState): EvalValue {
  return { condition: evalDefined(name, state), integer: null };
}

function integerValue(integer: bigint): EvalValue {
  return { condition: integer === 0n ? 'FALSE' : 'TRUE', integer };
}

type ComparisonKind = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

function compare(kind: ComparisonKind, left: EvalValue, right: EvalValue): EvalValue {
  if (left.integer === null || right.integer === null) {
    return { condition: 'UNKNOWN', integer: null };
  }

  let result: boolean;
  switch (kind) {
    case 'eq':
      result = left.integer === right.integer;
      break;
    case 'ne':
      result = left.integer !== right.integer;
      break;
    case 'lt':
      result = left.integer < right.integer;
      break;
    case 'le':
      result = left.integer <= right.integer;
      break;
    case 'gt':
      result = left.integer > right.integer;
      break;
    case 'ge':
      result = left.integer >= right.integer;
      break;
  }
  return conditionValue(result ? 'TRUE' : 'FALSE');
}

/**
 * Recursive-descent parser for the supported C-preprocessor expression subset:
 *
 *   or         := and ( '||' and )*
 *   and        := equality ( '&&' equality )*
 *   equality   := relational ( ('==' | '!=') relational )*
 *   relational := unary ( ('<' | '<=' | '>' | '>=') unary )*
 *   unary      := '!' unary | primary
 *   primary    := INTEGER | IDENT | defined-atom | '(' or ')'
 *
 * Returns `null` (→ UNKNOWN) for malformed or unsupported syntax.
 */
class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly state: MacroState,
  ) {}

  parse(): CondValue | null {
    const value = this.parseOr();
    if (value === null) return null;
    if (this.pos !== this.tokens.length) return null; // trailing tokens ⇒ unsupported
    return value.condition;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(): EvalValue | null {
    let acc = this.parseAnd();
    if (acc === null) return null;
    while (this.peek()?.kind === 'or') {
      this.pos++;
      const rhs = this.parseAnd();
      if (rhs === null) return null;
      acc = conditionValue(or(acc.condition, rhs.condition));
    }
    return acc;
  }

  private parseAnd(): EvalValue | null {
    let acc = this.parseEquality();
    if (acc === null) return null;
    while (this.peek()?.kind === 'and') {
      this.pos++;
      const rhs = this.parseEquality();
      if (rhs === null) return null;
      acc = conditionValue(and(acc.condition, rhs.condition));
    }
    return acc;
  }

  private parseEquality(): EvalValue | null {
    let acc = this.parseRelational();
    if (acc === null) return null;
    while (this.peek()?.kind === 'eq' || this.peek()?.kind === 'ne') {
      const operator = this.peek()!.kind as 'eq' | 'ne';
      this.pos++;
      const rhs = this.parseRelational();
      if (rhs === null) return null;
      acc = compare(operator, acc, rhs);
    }
    return acc;
  }

  private parseRelational(): EvalValue | null {
    let acc = this.parseUnary();
    if (acc === null) return null;
    while (
      this.peek()?.kind === 'lt'
      || this.peek()?.kind === 'le'
      || this.peek()?.kind === 'gt'
      || this.peek()?.kind === 'ge'
    ) {
      const operator = this.peek()!.kind as 'lt' | 'le' | 'gt' | 'ge';
      this.pos++;
      const rhs = this.parseUnary();
      if (rhs === null) return null;
      acc = compare(operator, acc, rhs);
    }
    return acc;
  }

  private parseUnary(): EvalValue | null {
    const t = this.peek();
    if (!t) return null;

    if (t.kind === 'not') {
      this.pos++;
      const inner = this.parseUnary();
      if (inner === null) return null;
      return conditionValue(not(inner.condition));
    }

    return this.parsePrimary();
  }

  private parsePrimary(): EvalValue | null {
    const t = this.peek();
    if (!t) return null;

    if (t.kind === 'defined') {
      this.pos++;
      return this.parseDefinedAtom();
    }

    if (t.kind === 'integer') {
      this.pos++;
      return integerValue(t.value);
    }

    if (t.kind === 'ident') {
      this.pos++;
      return macroValue(t.value, this.state);
    }

    if (t.kind === 'lparen') {
      this.pos++;
      const inner = this.parseOr();
      if (inner === null || this.peek()?.kind !== 'rparen') return null;
      this.pos++;
      return inner;
    }

    return null;
  }

  private parseDefinedAtom(): EvalValue | null {
    const t = this.peek();
    if (!t) return null;

    if (t.kind === 'lparen') {
      this.pos++;
      const name = this.peek();
      if (!name || name.kind !== 'ident') return null;
      this.pos++;
      const close = this.peek();
      if (!close || close.kind !== 'rparen') return null;
      this.pos++;
      return conditionValue(evalDefined(name.value, this.state));
    }

    if (t.kind === 'ident') {
      this.pos++;
      return conditionValue(evalDefined(t.value, this.state));
    }

    return null;
  }
}

/**
 * Evaluate a preprocessor condition.
 *
 * - `ifdef` / `ifndef` take a bare macro name in `exprText`.
 * - `if` / `elif` take an expression (same grammar) in `exprText`.
 *
 * `elif` uses the same expression grammar as `if`. Anything outside the
 * supported subset → `UNKNOWN`.
 */
export function evalCondition(kind: CondKind, exprText: string, state: MacroState): CondValue {
  if (kind === 'ifdef' || kind === 'ifndef') {
    const name = exprText.trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) return 'UNKNOWN';
    const v = evalDefined(name, state);
    return kind === 'ifndef' ? not(v) : v;
  }

  // kind === 'if' | 'elif'
  const tokens = tokenize(exprText);
  if (tokens === null || tokens.length === 0) return 'UNKNOWN';

  const value = new Parser(tokens, state).parse();
  return value === null ? 'UNKNOWN' : value;
}
