import { scanCommentRoles } from '../parser/masking';
import {
  exactSource,
  type ExactSource,
} from '../sourceLocation';

/** Build immutable lexical facts once for one published live source snapshot. */
export function prepareLiveSourceFacts(
  text: string,
  prepared?: ExactSource,
): ExactSource {
  const source = exactSource(text, prepared);
  if (
    (source.sourceLexicalLines?.length ?? 0) === source.sourceLines.length
    || (source.sourceBlockCommentStates?.length ?? 0) === source.sourceLines.length
  ) {
    return source;
  }

  const sourceBlockCommentStates: boolean[] = [];
  let inBlockComment = false;
  for (const line of source.sourceLines) {
    sourceBlockCommentStates.push(inBlockComment);
    const scan = scanCommentRoles(line, inBlockComment);
    inBlockComment = scan.inBlockComment;
  }
  return Object.freeze({
    sourceText: text,
    sourceLines: source.sourceLines,
    sourceBlockCommentStates,
  });
}
