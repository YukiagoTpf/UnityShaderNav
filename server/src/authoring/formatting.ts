import type { FormattingOptions, TextEdit } from 'vscode-languageserver/node';
import type { DocumentAnalysis } from '../analysis';

export function shaderLabIndentationEdits(
  analysis: DocumentAnalysis | undefined,
  text: string,
  options: FormattingOptions,
): TextEdit[] | null {
  if (!analysis?.layout.safe || analysis.sourceText !== text) return null;
  const tabSize = Number.isInteger(options.tabSize)
    && options.tabSize > 0
    && options.tabSize <= 16
    ? options.tabSize
    : 4;
  const unit = options.insertSpaces ? ' '.repeat(tabSize) : '\t';
  const edits: TextEdit[] = [];
  for (const fact of analysis.layout.lines) {
    if (fact.protected || !fact.code) continue;
    const line = analysis.sourceLines[fact.line] ?? '';
    const actual = /^[ \t]*/.exec(line)?.[0] ?? '';
    const desired = unit.repeat(fact.indentDepth);
    if (actual === desired) continue;
    edits.push({
      range: {
        start: { line: fact.line, character: 0 },
        end: { line: fact.line, character: actual.length },
      },
      newText: desired,
    });
  }
  return edits;
}
