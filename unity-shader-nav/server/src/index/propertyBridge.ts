import type {
  FileIndex,
  Position,
  ShaderLabPropertyEntry,
} from '@unity-shader-nav/shared';
import type { IndexStore } from './indexStore';

/**
 * Return the property entry whose name token covers the cursor position, or
 * null. Mirrors `findPropertyAt(idx.properties, position)` but operates directly
 * on the cached `FileIndex.properties` array so the definition handler can run
 * the predicate without re-scanning. Both endpoints are inclusive so the cursor
 * just past the last character still resolves to the entry.
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
  for (const uri of store.uris()) {
    const idx = store.get(uri);
    if (!idx?.properties) continue;
    for (const entry of idx.properties) {
      if (entry.name === name) out.push({ uri, entry });
    }
  }
  return out;
}
