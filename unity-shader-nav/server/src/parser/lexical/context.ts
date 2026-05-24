import type { Position } from '@unity-shader-nav/shared';
import { scanBlocks } from '../shaderlab/blockScanner';

type LexicalContext = 'code' | 'comment' | 'string';

function isShaderLabDocument(languageId: string | undefined, uri: string): boolean {
  return languageId === 'shaderlab' || /\.shader(?:$|[?#])/i.test(uri);
}

function isInsideShaderLabHlslBlock(text: string, pos: Position): boolean {
  return scanBlocks(text).blocks.some((block) =>
    pos.line >= block.contentStartLine && pos.line <= block.contentEndLine,
  );
}

function lexicalContextAt(text: string, pos: Position): LexicalContext {
  const lines = text.split(/\r?\n/);
  let inBlockComment = false;

  for (let line = 0; line <= pos.line && line < lines.length; line++) {
    const lineText = lines[line];
    let inString = false;
    const limit = line === pos.line ? Math.min(pos.character, lineText.length) : lineText.length;

    for (let character = 0; character <= limit; character++) {
      if (line === pos.line && character === pos.character) {
        if (inBlockComment) return 'comment';
        if (inString) return 'string';
        if (lineText[character] === '"') return 'string';
        return 'code';
      }

      const ch = lineText[character];
      const next = lineText[character + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          character++;
          inBlockComment = false;
        }
        continue;
      }

      if (inString) {
        if (ch === '\\' && next !== undefined) {
          character++;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '/' && next === '/') {
        if (line === pos.line) return 'comment';
        break;
      }

      if (ch === '/' && next === '*') {
        character++;
        inBlockComment = true;
        continue;
      }

      if (ch === '"') {
        inString = true;
      }
    }
  }

  return 'code';
}

export function isGenericDefinitionContext(
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): boolean {
  if (isShaderLabDocument(languageId, uri) && !isInsideShaderLabHlslBlock(text, pos)) {
    return false;
  }

  return lexicalContextAt(text, pos) === 'code';
}
