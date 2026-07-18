export { IndexStore, type IndexStoreReader } from './indexStore';
export { GlobalSymbolIndex, type GlobalSymbolReader } from './globalIndex';
export { GlobalReferenceIndex, type GlobalReferenceReader } from './globalReferences';
export { inferReceiverTypeForCompletion, resolveMemberSymbols } from './chainLookup';
export { resolveDefinitionSymbols } from './symbolResolver';
export {
  isScopedSymbol,
  selectGlobalSymbolEntries,
  selectNamedSymbolEntries,
  selectScopedSymbolEntries,
  selectSymbolEntryGroups,
} from './symbolSelection';
export {
  resolveDefinition,
  findReferences,
  findReferencesForTarget,
  findHighlights,
  selectActiveReferenceTargets,
} from './resolution';
export type {
  ResolverContext,
  ReferenceCollectionContext,
  HighlightCollectionContext,
  ActiveReferenceTargetSelection,
} from './resolution';
export { cursorTargetAt } from './cursorTarget';
// The reference-matching strategy (target predicates + referenceResolver
// variants) is index-internal: only resolution.ts composes it. uniqueLocations
// stays public as a generic Location[] dedup util (references.ts uses it for
// include-path dedup, independent of findReferences).
export { uniqueLocations } from './referenceMatching';
export { propertyAt, findPropertyCandidatesForName } from './propertyBridge';
export type { LocationLink } from './symbolResolver';
export type { CursorTarget, CursorTargetOptions } from './cursorTarget';
export type { PropertyCandidate } from './propertyBridge';
