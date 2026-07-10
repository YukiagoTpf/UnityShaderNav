import type {
  FileIndex,
  Position,
  ShaderLabPropertyEntry,
} from '@unity-shader-nav/shared';
import type { IndexStore } from './indexStore';

/**
 * Return the property entry whose name token covers the cursor position, or
 * null. Operates directly on the cached `FileIndex.properties` array so the
 * definition handler can run the predicate without re-scanning. Both endpoints
 * are inclusive so the cursor just past the last character still resolves to
 * the entry.
 */
export function propertyAt(
  idx: FileIndex,
  position: Position,
): ShaderLabPropertyEntry | null {
  if (!idx.properties) return null;
  for (const entry of idx.properties) {
    const { start, end } = entry.nameRange;
    if (position.line !== start.line) continue;
    if (position.character < start.character) continue;
    if (position.character > end.character) continue;
    return entry;
  }
  return null;
}

export interface PropertyCandidate {
  uri: string;
  entry: ShaderLabPropertyEntry;
}

/**
 * Collect every `.shader` Properties entry in the workspace whose name equals
 * `name`. Design decision 3 (issue 20 plan): the reverse direction bypasses
 * include-visibility and surfaces every indexed shader's property — the user
 * disambiguates via VS Code Peek (ADR-0001). No async, no include resolution,
 * O(shaders) per F12 request.
 */
export function findPropertyCandidatesForName(
  name: string,
  store: Pick<IndexStore, 'uris' | 'get'>,
): PropertyCandidate[] {
  const out: PropertyCandidate[] = [];
  for (const storeUri of store.uris()) {
    const idx = store.get(storeUri);
    if (!idx?.properties) continue;
    // Emit `idx.uri`, not the store's iterator key. `IndexStore` keys go
    // through `uriKey` which lowercases the Windows drive letter, so
    // returning `storeUri` would round-trip a different casing than every
    // other LocationLink in the same response (which all use
    // `symbol.location.uri` / `idx.uri`).
    for (const entry of idx.properties) {
      if (entry.name === name) out.push({ uri: idx.uri, entry });
    }
  }
  return out;
}
