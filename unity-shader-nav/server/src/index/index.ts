export { IndexStore } from './indexStore';
export { GlobalSymbolIndex } from './globalIndex';
export { GlobalReferenceIndex } from './globalReferences';
export { inferReceiverTypeForCompletion, resolveMember, resolveMemberSymbols } from './chainLookup';
export { resolveDefinition, resolveDefinitionSymbols } from './symbolResolver';
export {
  resolveReferenceTargets,
  resolveReferenceTargetsForMemberReference,
  resolveReferenceTargetsForName,
} from './referenceResolver';
export { memberAccessAt, wordAt } from './wordAt';
export { collectVisibleUriKeys } from './visibility';
export type { ReferenceTarget } from './referenceResolver';
export type { LocationLink } from './symbolResolver';
export type { MemberAccess, WordAt } from './wordAt';
