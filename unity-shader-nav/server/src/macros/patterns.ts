export type ParamKind = 'capture' | 'placeholder';

export interface ParamSlot {
  kind: ParamKind;
  /** When kind === 'capture', the variable name (e.g. "name" / "func"). */
  name?: string;
}

export interface CompiledPattern {
  /** For call macros: the macro name. For pragma references: "#pragma vertex" (head string). */
  head: string;
  params: ParamSlot[];
  isPragma: boolean;
}

const PARAM_RE = /^\s*(?:\$(\w+)|_)\s*$/;

export function parsePattern(src: string): CompiledPattern {
  const isPragma = src.startsWith('#pragma');
  if (isPragma) {
    const m = /^#pragma\s+(\S+)\s+\$(\w+)\s*$/.exec(src);
    if (!m) throw new Error(`malformed pragma pattern: ${src}`);
    return {
      head: `#pragma ${m[1]}`,
      params: [{ kind: 'capture', name: m[2] }],
      isPragma: true,
    };
  }

  const m = /^([A-Z_][A-Z0-9_]*)\s*\((.*)\)\s*$/.exec(src);
  if (!m) throw new Error(`malformed macro pattern: ${src}`);
  const head = m[1];
  const inside = m[2].trim();
  const params: ParamSlot[] = inside.length === 0
    ? []
    : inside.split(',').map((raw) => {
      const pm = PARAM_RE.exec(raw);
      if (!pm) throw new Error(`bad param ${raw} in ${src}`);
      if (pm[1]) return { kind: 'capture', name: pm[1] };
      return { kind: 'placeholder' };
    });

  return { head, params, isPragma: false };
}
