import { pathToFileURL } from 'node:url';
import type { IncludeContext } from '../include';
import { resolveInclude } from '../include';
import type { IndexStore } from './indexStore';
import { uriKey } from './uriKey';

export async function collectVisibleUriKeys(
  store: Pick<IndexStore, 'get'>,
  includeCtx: IncludeContext,
  rootUri: string,
): Promise<Set<string>> {
  const visible = new Set<string>();
  const queue = [rootUri];

  for (let i = 0; i < queue.length; i++) {
    const uri = queue[i];
    const key = uriKey(uri);
    if (visible.has(key)) continue;

    visible.add(key);
    const index = store.get(uri);
    if (!index) continue;

    for (const reference of index.references) {
      if (reference.context !== 'include') continue;

      const resolved = await resolveInclude(reference.name, uri, includeCtx);
      if (!resolved) continue;

      queue.push(pathToFileURL(resolved.absolutePath).href);
    }
  }

  return visible;
}
