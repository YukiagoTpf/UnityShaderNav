import { pathToFileURL } from 'node:url';
import type { FileIndex } from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import {
  memoizeDirectoryListings,
  resolveInclude,
  type FileProbe,
} from './resolver';
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
 * Captures one immutable index view and its matching include context. Resolution,
 * transitive visibility, and directory-listing work is shared only for this
 * chain's lifetime; a later publication constructs a cold chain.
 */
export function createIncludeChain(
  index: IncludeIndexView,
  context: IncludeContext,
  probe?: FileProbe,
): IncludeChain {
  const revisionProbe = memoizeDirectoryListings(probe);
  const resolutionsBySource = new Map<
    string,
    Map<string, Promise<ResolvedInclude | null>>
  >();
  const resolvePath = (includePath: string, fromFileUri: string) => {
    const sourceKey = uriKey(fromFileUri);
    let resolutions = resolutionsBySource.get(sourceKey);
    if (!resolutions) {
      resolutions = new Map();
      resolutionsBySource.set(sourceKey, resolutions);
    }
    const cached = resolutions.get(includePath);
    if (cached) return cached;

    // Retain every outcome for this revision, including null and unexpected
    // rejection. A later publication creates a fresh IncludeChain and retries.
    const resolution = resolveInclude(includePath, fromFileUri, context, revisionProbe);
    resolutions.set(includePath, resolution);
    return resolution;
  };
  const visibleClosures = new Map<string, Promise<ReadonlySet<string>>>();

  const collectVisibleUriKeys = async (rootUri: string): Promise<ReadonlySet<string>> => {
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
  };

  return Object.freeze({
    resolve: resolvePath,
    visibleUriKeys(rootUri: string): Promise<ReadonlySet<string>> {
      const rootKey = uriKey(rootUri);
      let closure = visibleClosures.get(rootKey);
      if (!closure) {
        closure = collectVisibleUriKeys(rootUri);
        visibleClosures.set(rootKey, closure);
      }

      // The cached Set stays private even though ReadonlySet is compile-time
      // only. Each caller may mutate its copy without corrupting this revision.
      return closure.then((visible) => new Set(visible));
    },
  });
}
