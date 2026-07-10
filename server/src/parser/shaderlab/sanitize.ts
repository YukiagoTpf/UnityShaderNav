// Mask comment and structural-noise content so downstream scanners can:
//   1. Match regexes like /Shader\s+"([^"]*)"/ against the line (string
//      contents are preserved so the captured name is intact).
//   2. Count `{` / `}` for ShaderLab structure depth (braces inside string
//      literals and comments are replaced with spaces so they don't shift
//      the depth).
//
// Output length is identical to input so column positions stay valid.
// Multi-line block comments are NOT carried across lines (intentional MVP
// limitation; callers needing multiline awareness must implement their own
// state).

const enum S { Code, Line, Block, Str }

export function sanitizeLine(line: string): string {
  let state: S = S.Code;
  const out: string[] = new Array(line.length);
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    switch (state) {
      case S.Code:
        if (ch === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = S.Line; break; }
        if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i++; state = S.Block; break; }
        if (ch === '"') { out[i] = ch; state = S.Str; break; }
        out[i] = ch;
        break;
      case S.Line:
        out[i] = ' ';
        break;
      case S.Block:
        if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = S.Code; break; }
        out[i] = ' ';
        break;
      case S.Str:
        if (ch === '"') { out[i] = ch; state = S.Code; break; }
        if (ch === '\\' && next !== undefined) { out[i] = ch; out[i + 1] = next; i++; break; }
        // Inside a string: preserve readable content, mask only braces so
        // ShaderLab depth counting is not perturbed by `"}"` / `"{"` literals.
        out[i] = (ch === '{' || ch === '}') ? ' ' : ch;
        break;
    }
  }
  return out.join('');
}
