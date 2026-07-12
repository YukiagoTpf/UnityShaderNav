import { pathToFileURL } from 'node:url';
import type { FileIndex } from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import { resolveInclude, type FileProbe } from './resolver';
import type { IncludeContext, ResolvedInclude } from './types';

export interface IncludeIndexView {
  get(uri: string): FileIndex | undefined;
}

/** Revision-bound interpretation of direct includes and transitive visibility. */
export interface IncludeChain {
  resolve(includePath: string, fromFileUri: string): Promise<ResolvedInclude | null>;
  visibleUriKeys(rootUri: string): Promise<ReadonlySet<string>>;
}

/**
 * Captures one immutable index view and its matching include context. Results
 * intentionally are not memoized across requests: each call observes only the
 * captured revision while avoiding process-lifetime filesystem state.
 */
export function createIncludeChain(
  index: IncludeIndexView,
  context: IncludeContext,
  probe?: FileProbe,
): IncludeChain {
  const resolvePath = (includePath: string, fromFileUri: string) => (
    probe
      ? resolveInclude(includePath, fromFileUri, context, probe)
      : resolveInclude(includePath, fromFileUri, context)
  );

  return Object.freeze({
    resolve: resolvePath,
    async visibleUriKeys(rootUri: string): Promise<ReadonlySet<string>> {
      const visible = new Set<string>();
      const queue = [rootUri];

      for (let indexPosition = 0; indexPosition < queue.length; indexPosition++) {
        const uri = queue[indexPosition];
        const key = uriKey(uri);
        if (visible.has(key)) continue;

        visible.add(key);
        const fileIndex = index.get(uri);
        if (!fileIndex) continue;

        for (const reference of fileIndex.references) {
          if (reference.context !== 'include') continue;
          const resolved = await resolvePath(reference.name, uri);
          if (resolved) queue.push(pathToFileURL(resolved.absolutePath).href);
        }
      }

      return visible;
    },
  });
}
