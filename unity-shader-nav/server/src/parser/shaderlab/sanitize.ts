// Replace anything inside string literals (`"..."`), line comments (`// ...`),
// and same-line block comments (`/* ... */`) with spaces. Output is the same
// length as input so column-based positions stay valid. Multi-line block
// comments are NOT carried across lines (intentional MVP limitation; callers
// that need multiline awareness must implement their own state).

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
        if (ch === '\\' && next !== undefined) { out[i] = ' '; out[i + 1] = ' '; i++; break; }
        out[i] = ' ';
        break;
    }
  }
  return out.join('');
}
