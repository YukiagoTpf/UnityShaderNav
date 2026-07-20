import { createHash } from 'node:crypto';
import type {
  CSharpPropertyReferenceLocation,
  CSharpPropertyUsage,
  CSharpShaderIdentity,
} from '@unity-shader-nav/shared';
import type { CancellationToken } from 'vscode-languageserver/node';
import {
  awaitWithRequestCancellation,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import type {
  CSharpCurrentSourceProvider,
  CSharpPropertyUsageProvider,
} from '../adapter/csharpPropertySource';
import type { MaterialPropertyTarget } from './materialReferences';

function unityAssetPath(uri: string): string {
  try {
    const { pathname } = new URL(uri);
    const match = /(?:^|\/)((?:Assets|Packages)\/.*)$/.exec(pathname);
    return match?.[1] ?? pathname;
  } catch {
    return uri;
  }
}

/**
 * A usage is authoritative only when the Adapter proved the binding to a
 * specific Shader (binding-proven) AND the property name is a provable
 * constant expression (constant-string or constant-concat). Name-only and
 * dynamic items are visible in the raw payload for explicit rejection
 * testing but never become authoritative references.
 */
function isAuthoritativeUsage(
  usage: CSharpPropertyUsage,
): usage is CSharpPropertyUsage & {
  readonly bindingDeterminism: 'proven';
  readonly expressionDeterminism: 'constant-string' | 'constant-concat';
  readonly shader: CSharpShaderIdentity;
} {
  if (usage.bindingDeterminism !== 'proven') return false;
  if (
    usage.expressionDeterminism !== 'constant-string'
    && usage.expressionDeterminism !== 'constant-concat'
  ) {
    return false;
  }
  if (!usage.shader) return false;
  if (!usage.propertyName) return false;
  return true;
}

/** Validate that a usage range falls within the bounds of the current text. */
function rangeWithinText(usage: CSharpPropertyUsage, text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/);
  const { range } = usage;
  return range.start.line < lines.length
    && range.end.line < lines.length
    && range.start.character <= (lines[range.start.line]?.length ?? -1)
    && range.end.character <= (lines[range.end.line]?.length ?? -1);
}

/**
 * Accept Adapter C# property usages only for the exact source text currently
 * observable through the explicit current-source provider. The provider is
 * required: without it (or when it returns null for a URI), no authoritative
 * reference can be produced. Hashing proves revision identity without parsing
 * C#. A missing provider, an unknown source, a content-hash mismatch, or a
 * range that falls outside the current text all reject the usage so stale C#
 * positions never enter References.
 */
async function currentCSharpPropertyUsages<T extends CSharpPropertyUsage>(
  usages: readonly T[],
  currentSourceProvider: CSharpCurrentSourceProvider | undefined,
  cancellation?: CancellationToken,
): Promise<readonly T[]> {
  if (usages.length === 0 || !currentSourceProvider) return [];
  throwIfRequestCancelled(cancellation);

  const sources = new Map<string, Promise<{
    text: string;
    contentHash: string;
  } | null>>();
  const currentSource = (uri: string): Promise<{
    text: string;
    contentHash: string;
  } | null> => {
    let pending = sources.get(uri);
    if (pending) return pending;
    pending = (async () => {
      try {
        const snapshot = await currentSourceProvider.currentSourceFor(uri);
        if (!snapshot) return null;
        // Compute the hash from the observed text so a provider cannot bypass
        // freshness by reporting a stale hash alongside mismatched text.
        return {
          text: snapshot.text,
          contentHash: createHash('sha256').update(snapshot.text, 'utf8').digest('hex'),
        };
      } catch {
        return null;
      }
    })();
    sources.set(uri, pending);
    return pending;
  };

  const freshness = await awaitWithRequestCancellation(
    Promise.all(usages.map(async (usage) => ({
      usage,
      current: await currentSource(usage.uri),
    }))),
    cancellation,
  );
  throwIfRequestCancelled(cancellation);
  return freshness
    .filter(({ usage, current }) => (
      current !== null
      && current.contentHash === usage.sourceRevision.contentHash
      && rangeWithinText(usage, current.text)
    ))
    .map(({ usage }) => usage);
}

export async function csharpPropertyReferences(
  documentUri: string,
  target: MaterialPropertyTarget,
  provider: CSharpPropertyUsageProvider,
  currentSourceProvider: CSharpCurrentSourceProvider | undefined,
  cancellation?: CancellationToken,
): Promise<CSharpPropertyReferenceLocation[]> {
  // Without an explicit current-source provider, no authoritative reference
  // can be produced. The production client has no C# document selector, so
  // the server cannot observe open C# buffers; #95 must add that bridge.
  if (!currentSourceProvider) return [];
  throwIfRequestCancelled(cancellation);
  const result = await provider.csharpPropertyUsagesFor({
    shaderName: target.shaderName,
    shaderPath: unityAssetPath(documentUri),
    propertyName: target.property.name,
  });
  throwIfRequestCancelled(cancellation);
  if (result.availability === 'unknown') return [];

  const authoritative = result.usages.filter(isAuthoritativeUsage);
  const current = await currentCSharpPropertyUsages(
    authoritative,
    currentSourceProvider,
    cancellation,
  );

  return current.map((usage) => ({
    uri: usage.uri,
    range: usage.range,
    data: {
      kind: 'csharp-property-usage',
      propertyName: usage.propertyName,
      propertyType: usage.propertyType,
      callKind: usage.callKind,
      receiverType: usage.receiverType,
      bindingDeterminism: 'proven',
      expressionDeterminism: usage.expressionDeterminism,
      shader: usage.shader,
      sourceRevision: usage.sourceRevision,
      provenance: usage.provenance,
    },
  }));
}
