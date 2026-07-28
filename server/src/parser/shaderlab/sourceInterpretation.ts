import {
  maskCommentScan,
  scanCommentRoles,
  type CommentRole,
} from '../masking';
import { splitSourceLines } from '../../sourceLines';

export interface ShaderLabSourceLine {
  readonly line: number;
  readonly raw: string;
  /** Per-column lexical roles for the exact raw line, including its EOL sentinel. */
  readonly commentRoles: readonly CommentRole[];
  readonly lineComment: boolean;
  /** Comments blanked; string contents preserved. */
  readonly code: string;
  /** Comments and complete string literals blanked. */
  readonly codeWithoutStrings: string;
  /** Comments and string bodies blanked, while quote columns remain stable. */
  readonly stringBodyMaskedCode: string;
  /** Comments plus braces inside strings blanked; other string text remains readable. */
  readonly braceSafeCode: string;
  readonly unterminatedString: boolean;
}

export interface ShaderLabSourceInterpretation {
  readonly sourceText: string;
  readonly lines: readonly ShaderLabSourceLine[];
  readonly lineEnding: '\n' | '\r\n';
  readonly unterminatedBlockComment: boolean;
}

/**
 * Interpret one exact ShaderLab snapshot once. Every downstream projection uses
 * these width-preserving line facts instead of splitting and lexing the source again.
 */
export function interpretShaderLabSource(text: string): ShaderLabSourceInterpretation {
  return interpretShaderLabSourceLines(text, splitSourceLines(text));
}

/** Interpret already-split lines that are proven to belong to `text`. */
export function interpretShaderLabSourceLines(
  text: string,
  rawLines: readonly string[],
): ShaderLabSourceInterpretation {
  const lines: ShaderLabSourceLine[] = [];
  let inBlockComment = false;

  for (let line = 0; line < rawLines.length; line++) {
    const raw = rawLines[line];
    const scan = scanCommentRoles(raw, inBlockComment);
    inBlockComment = scan.inBlockComment;
    lines.push({
      line,
      raw,
      commentRoles: scan.roles,
      lineComment: scan.lineComment,
      code: maskCommentScan(raw, scan),
      codeWithoutStrings: maskCommentScan(raw, scan, { strings: 'blank-all' }),
      stringBodyMaskedCode: maskCommentScan(raw, scan, { strings: 'blank-body' }),
      braceSafeCode: maskCommentScan(raw, scan, { strings: 'blank-braces' }),
      unterminatedString: scan.inString,
    });
  }

  return {
    sourceText: text,
    lines,
    lineEnding: text.includes('\r\n') ? '\r\n' : '\n',
    unterminatedBlockComment: inBlockComment,
  };
}
