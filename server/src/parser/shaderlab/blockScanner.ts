import type { BlockKind, ScanResult, ShaderLabBlock } from '@unity-shader-nav/shared';
import {
  interpretShaderLabSource,
  type ShaderLabSourceInterpretation,
} from './sourceInterpretation';

const START_DIRECTIVES: Record<string, BlockKind> = {
  HLSLPROGRAM: 'HLSLPROGRAM',
  CGPROGRAM: 'CGPROGRAM',
  HLSLINCLUDE: 'HLSLINCLUDE',
  CGINCLUDE: 'CGINCLUDE',
};

const END_DIRECTIVES_FOR: Record<BlockKind, string> = {
  HLSLPROGRAM: 'ENDHLSL',
  CGPROGRAM: 'ENDCG',
  HLSLINCLUDE: 'ENDHLSL',
  CGINCLUDE: 'ENDCG',
};

export function scanBlocks(text: string): ScanResult {
  return scanBlocksFromSource(interpretShaderLabSource(text));
}

export function scanBlocksFromSource(source: ShaderLabSourceInterpretation): ScanResult {
  const lines = source.lines;
  const blocks: ShaderLabBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const startKind = START_DIRECTIVES[lines[i].code.trim()];
    if (!startKind) { i++; continue; }

    const startLine = i;
    const endDirective = END_DIRECTIVES_FOR[startKind];
    let endLine = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].code.trim() === endDirective) {
        endLine = j;
        break;
      }
    }

    if (endLine === -1) {
      blocks.push({
        kind: startKind,
        startLine,
        endLine: lines.length - 1,
        contentStartLine: startLine + 1,
        contentEndLine: lines.length - 1,
        unterminated: true,
      });
      i = lines.length;
    } else {
      blocks.push({
        kind: startKind,
        startLine,
        endLine,
        contentStartLine: startLine + 1,
        contentEndLine: endLine - 1,
        unterminated: false,
      });
      i = endLine + 1;
    }
  }

  return { blocks };
}
