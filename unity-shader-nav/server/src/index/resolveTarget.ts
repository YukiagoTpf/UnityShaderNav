import type { FileIndex, Position, SymbolEntry } from '@unity-shader-nav/shared';
import type { GlobalSymbolIndex } from './globalIndex';
import type { CursorTarget } from './cursorTarget';
import { resolveDefinitionSymbols, type ResolutionOptions } from './symbolResolver';
import { resolveMemberSymbols } from './chainLookup';

export interface ResolverContext {
  index: FileIndex;
  global: GlobalSymbolIndex | null;
  position: Position;
  options?: ResolutionOptions;
}

export function resolveTarget(target: CursorTarget, ctx: ResolverContext): SymbolEntry[] {
  switch (target.kind) {
    case 'member':
      return resolveMemberSymbols(
        ctx.index,
        ctx.global,
        target.receiver.text,
        target.member.text,
        ctx.position,
        ctx.options,
      );
    case 'symbol':
      return resolveDefinitionSymbols(ctx.index, target.word.text, ctx.position, ctx.global, ctx.options);
    default:
      return []; // include | none
  }
}
