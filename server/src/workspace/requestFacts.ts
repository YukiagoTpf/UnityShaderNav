import type { Position } from '@unity-shader-nav/shared';
import type { DocumentAnalysis } from '../analysis';
import { cursorTargetAt, type CursorTarget } from '../index/cursorTarget';
import {
  analyzeCursor,
  type CursorContext,
  type CursorSource,
} from '../parser/lexical/cursor';
import { exactSource } from '../sourceLocation';
import { callContextAt, type CallContext } from '../suggestions/callContext';
import type { IndexedDocumentSnapshot } from './indexedWorkspace';

export interface CursorRequestFacts {
  readonly source: CursorSource;
  readonly cursor: CursorContext;
  target(options?: { readonly detectIncludes?: boolean }): CursorTarget;
  call(): CallContext | null;
}

export function createCursorRequestFacts(
  document: IndexedDocumentSnapshot,
  position: Position,
  prepared?: DocumentAnalysis,
): CursorRequestFacts {
  const source = exactSource(document.text, prepared) as CursorSource;
  const cursor = analyzeCursor(source, position, document.languageId, document.uri);
  let withIncludes: CursorTarget | undefined;
  let withoutIncludes: CursorTarget | undefined;
  let call: CallContext | null | undefined;
  return Object.freeze({
    source,
    cursor,
    target(options?: { readonly detectIncludes?: boolean }): CursorTarget {
      const detectIncludes = options?.detectIncludes !== false;
      if (detectIncludes && withIncludes) return withIncludes;
      if (!detectIncludes && withoutIncludes) return withoutIncludes;
      const target = cursorTargetAt(source, position, { detectIncludes, cursor });
      if (detectIncludes) withIncludes = target;
      else withoutIncludes = target;
      return target;
    },
    call(): CallContext | null {
      if (call !== undefined) return call;
      call = callContextAt(source, position);
      return call;
    },
  });
}
