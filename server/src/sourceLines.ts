/**
 * The line model every position this server reports has to agree with.
 *
 * LSP positions are (line, character) pairs interpreted by the client against
 * its own document. `vscode-languageserver-textdocument` — and VS Code itself —
 * terminate a line on CRLF, on a lone CR, or on a lone LF. Splitting on
 * `/\r?\n/` instead silently disagrees whenever a lone CR appears: a file saved
 * with `\r\r\n` endings (a double-converted file, which real projects do
 * contain) reads as half as many lines here as at the client, so every line
 * number past the first names the wrong line and the error grows with depth.
 *
 * Splitting is centralized here so a future reader does not have to rediscover
 * which of the two spellings is the correct one.
 */
const LINE_TERMINATOR = /\r\n|\r|\n/;

/** Split source text into lines exactly as the LSP client does. */
export function splitSourceLines(text: string): string[] {
  return text.split(LINE_TERMINATOR);
}
