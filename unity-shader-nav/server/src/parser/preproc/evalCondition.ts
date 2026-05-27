/**
 * Four-valued evaluation of the small subset of preprocessor conditions this
 * analyzer supports. Deliberately *not* a general C expression evaluator:
 * anything outside the supported grammar collapses to `UNKNOWN` (kept visible).
 *
 * `UNKNOWN` dominates `VARIANT` in the `and`/`or` tables (review-P1): a branch
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
  | { kind: 'ident'; value: string };

/**
 * Tokenize on the supported set only: `defined`, `(`, `)`, `!`, `&&`, `||`, and
 * identifiers. Returns `null` on any character outside this set so callers fall
 * back to `UNKNOWN`.
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
    if (c === '!') {
      tokens.push({ kind: 'not' });
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
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(expr[j])) j++;
      const word = expr.slice(i, j);
      tokens.push(word === 'defined' ? { kind: 'defined' } : { kind: 'ident', value: word });
      i = j;
      continue;
    }
    // Anything else (digits, comparison ops, commas, etc.) is unsupported.
    return null;
  }

  return tokens;
}

/**
 * Recursive-descent parser for the tiny grammar:
 *
 *   expr   := term ( '&&' term )* | term ( '||' term )*   // no mixing &&/||
 *   term   := '!' term | 'defined' atom
 *   atom   := '(' IDENT ')' | IDENT
 *
 * Returns `null` (→ UNKNOWN) for anything it can't model, including a mix of
 * `&&` and `||` at the same level.
 */
class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly state: MacroState,
  ) {}

  parse(): CondValue | null {
    const value = this.parseExpr();
    if (value === null) return null;
    if (this.pos !== this.tokens.length) return null; // trailing tokens ⇒ unsupported
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseExpr(): CondValue | null {
    const first = this.parseTerm();
    if (first === null) return null;

    const next = this.peek();
    if (!next || next.kind === 'rparen') return first;
    if (next.kind !== 'and' && next.kind !== 'or') return null;

    const op = next.kind; // lock to a single operator for the whole chain
    let acc = first;
    while (this.peek() && this.peek()!.kind === op) {
      this.pos++; // consume operator
      const rhs = this.parseTerm();
      if (rhs === null) return null;
      acc = op === 'and' ? and(acc, rhs) : or(acc, rhs);
    }

    // Reject a mix like `defined(A) && defined(B) || defined(C)`.
    const after = this.peek();
    if (after && (after.kind === 'and' || after.kind === 'or')) return null;

    return acc;
  }

  private parseTerm(): CondValue | null {
    const t = this.peek();
    if (!t) return null;

    if (t.kind === 'not') {
      this.pos++;
      const inner = this.parseTerm();
      if (inner === null) return null;
      return not(inner);
    }

    if (t.kind === 'defined') {
      this.pos++;
      return this.parseDefinedAtom();
    }

    return null;
  }

  private parseDefinedAtom(): CondValue | null {
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
      return evalDefined(name.value, this.state);
    }

    if (t.kind === 'ident') {
      this.pos++;
      return evalDefined(t.value, this.state);
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
