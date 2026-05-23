import type { Range } from '@unity-shader-nav/shared';

export interface DefineDirective {
  name: string;
  line: number;
  nameRange: Range;
}

const DEFINE_RE = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/;

export function scanDefines(text: string): DefineDirective[] {
  const lines = text.split(/\r?\n/);
  const out: DefineDirective[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.replace(/\/\/.*$/, '');
    const match = DEFINE_RE.exec(code);
    if (!match) continue;

    const name = match[1];
    const defineStart = code.indexOf('define');
    const nameStart = code.indexOf(name, defineStart + 'define'.length);
    out.push({
      name,
      line: i,
      nameRange: {
        start: { line: i, character: nameStart },
        end: { line: i, character: nameStart + name.length },
      },
    });
  }

  return out;
}
