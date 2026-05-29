export { IndexStore } from './indexStore';
export { GlobalSymbolIndex } from './globalIndex';
export { GlobalReferenceIndex } from './globalReferences';
export { inferReceiverTypeForCompletion, resolveMember, resolveMemberSymbols } from './chainLookup';
export { resolveDefinition, resolveDefinitionSymbols } from './symbolResolver';
export { resolveTarget } from './resolveTarget';
export type { ResolverContext } from './resolveTarget';
export {
  resolveReferenceTargets,
  resolveReferenceTargetsForMemberReference,
  resolveReferenceTargetsForName,
} from './referenceResolver';
export { memberAccessAt, wordAt } from './wordAt';
export { cursorTargetAt } from './cursorTarget';
export {
  isGlobalKindAwareTarget,
  isMemberTarget,
  isReferenceContextCompatible,
  isScopedTarget,
  narrowGlobalTargetsForOccurrence,
  sameTarget,
  symbolToTarget,
  uniqueLocations,
} from './referenceMatching';
export { collectVisibleUriKeys } from './visibility';
export { propertyAt, findPropertyCandidatesForName } from './propertyBridge';
export type { ReferenceTarget } from './referenceResolver';
export type { LocationLink } from './symbolResolver';
export type { MemberAccess, WordAt } from './wordAt';
export type { CursorTarget, CursorTargetOptions } from './cursorTarget';
export type { PropertyCandidate } from './propertyBridge';
