import type Parser from 'web-tree-sitter';
import type { FileIndex } from '@unity-shader-nav/shared';
import type { DocumentAnalysis } from '../../analysis';
import type { MacroPatternRecognizer } from '../../macros';
import type { ExactSource } from '../../sourceLocation';
import { indexFileWithTreeProvider } from './fileIndexer';
import {
  createHlslParser,
  stabilizeHlslSource,
  type HlslParserFactory,
  type ReusableHlslParser,
} from './parser';

interface RetainedTree {
  readonly stabilizedText: string;
  readonly tree: Parser.Tree;
}

export class LiveDocumentTreeSession {
  private readonly createParser: HlslParserFactory;
  private parserAttempt: Promise<ReusableHlslParser> | undefined;
  private parser: ReusableHlslParser | undefined;
  private readonly releasedParsers = new WeakSet<object>();
  private forest: RetainedTree[] = [];
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private indexing = false;
  private disposed = false;

  constructor(createParser: HlslParserFactory = createHlslParser) {
    this.createParser = createParser;
  }

  indexFile(
    uri: string,
    text: string,
    recognizer?: MacroPatternRecognizer,
    analysis?: DocumentAnalysis,
    source?: ExactSource,
  ): Promise<FileIndex> {
    const generation = this.generation;
    const result = this.tail.then(() => this.performIndex(
      generation,
      uri,
      text,
      recognizer,
      analysis,
      source,
    ));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (!this.indexing) this.releaseRetainedResources();
  }

  private async performIndex(
    generation: number,
    uri: string,
    text: string,
    recognizer: MacroPatternRecognizer | undefined,
    analysis: DocumentAnalysis | undefined,
    source: ExactSource | undefined,
  ): Promise<FileIndex> {
    this.assertCurrent(generation);
    const parser = await this.acquireParser(generation);
    this.assertCurrent(generation);
    const previous = this.forest;
    this.forest = [];
    const next: RetainedTree[] = [];
    this.indexing = true;
    try {
      const index = await indexFileWithTreeProvider(
        uri,
        text,
        recognizer,
        analysis,
        async (blockText, blockIndex) => {
          this.assertCurrent(generation);
          const stabilizedText = stabilizeHlslSource(blockText);
          const retained = previous[blockIndex];
          if (retained?.stabilizedText === stabilizedText) {
            next[blockIndex] = retained;
            return retained.tree;
          }
          if (retained) retained.tree.edit(replacementEdit(
            retained.stabilizedText,
            stabilizedText,
          ));
          const tree = parser.parseStabilized(stabilizedText, retained?.tree);
          next[blockIndex] = { stabilizedText, tree };
          return tree;
        },
        source,
      );
      this.assertCurrent(generation);
      deleteTrees(previous.filter((entry) => !next.includes(entry)));
      this.forest = next;
      return index;
    } catch (error) {
      deleteTrees([...previous, ...next]);
      this.forest = [];
      throw error;
    } finally {
      this.indexing = false;
      if (this.disposed) this.releaseRetainedResources();
    }
  }

  private async acquireParser(generation: number): Promise<ReusableHlslParser> {
    if (!this.parserAttempt) this.parserAttempt = this.createParser();
    const attempt = this.parserAttempt;
    let parser: ReusableHlslParser;
    try {
      parser = await attempt;
    } catch (error) {
      if (this.parserAttempt === attempt) this.parserAttempt = undefined;
      throw error;
    }
    if (this.disposed || generation !== this.generation) this.releaseParser(parser);
    this.assertCurrent(generation);
    this.parser = parser;
    return parser;
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) {
      throw new Error('Live document tree session was disposed');
    }
  }

  private releaseParser(parser: ReusableHlslParser): void {
    if (this.releasedParsers.has(parser)) return;
    this.releasedParsers.add(parser);
    parser.delete();
  }

  private releaseRetainedResources(): void {
    deleteTrees(this.forest);
    this.forest = [];
    const parser = this.parser;
    this.parser = undefined;
    if (parser) this.releaseParser(parser);
    const attempt = this.parserAttempt;
    this.parserAttempt = undefined;
    if (attempt) {
      void attempt.then(
        (created) => this.releaseParser(created),
        () => undefined,
      );
    }
  }
}

function deleteTrees(entries: readonly RetainedTree[]): void {
  const trees = new Set(entries.map((entry) => entry.tree));
  for (const tree of trees) tree.delete();
}

function replacementEdit(oldText: string, newText: string): Parser.Edit {
  let start = 0;
  while (start < oldText.length && start < newText.length) {
    const oldCodePoint = oldText.codePointAt(start)!;
    if (oldCodePoint !== newText.codePointAt(start)) break;
    start += oldCodePoint > 0xffff ? 2 : 1;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start) {
    const oldPoint = codePointBefore(oldText, oldEnd);
    const newPoint = codePointBefore(newText, newEnd);
    if (oldPoint.value !== newPoint.value) break;
    oldEnd -= oldPoint.width;
    newEnd -= newPoint.width;
  }

  return {
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: pointAt(oldText, start),
    oldEndPosition: pointAt(oldText, oldEnd),
    newEndPosition: pointAt(newText, newEnd),
  };
}

function codePointBefore(text: string, end: number): { value: number; width: number } {
  const trailing = text.charCodeAt(end - 1);
  if (trailing >= 0xdc00 && trailing <= 0xdfff && end >= 2) {
    const leading = text.charCodeAt(end - 2);
    if (leading >= 0xd800 && leading <= 0xdbff) {
      return {
        value: ((leading - 0xd800) * 0x400) + trailing - 0xdc00 + 0x10000,
        width: 2,
      };
    }
  }
  return { value: trailing, width: 1 };
}

function pointAt(text: string, index: number): Parser.Point {
  let row = 0;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    if (text.charCodeAt(cursor) !== 0x0a) continue;
    row++;
    lineStart = cursor + 1;
  }
  return { row, column: index - lineStart };
}
