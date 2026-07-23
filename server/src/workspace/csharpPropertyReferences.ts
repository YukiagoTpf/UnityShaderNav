import { createHash } from 'node:crypto';
import type {
  CSharpPropertyAccessor,
  CSharpPropertyEvidenceLocation,
  CSharpPropertyReferenceLocation,
  CSharpPropertyUncertainData,
  CSharpPropertyUncertainLocation,
  CSharpPropertyUsage,
  CSharpShaderIdentity,
  ShaderLabPropertyType,
} from '@unity-shader-nav/shared';
import {
  DiagnosticSeverity,
  type CancellationToken,
  type Diagnostic,
} from 'vscode-languageserver/node';
import {
  awaitWithRequestCancellation,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import type {
  CSharpCurrentSourceProvider,
  CSharpPropertyUsageProvider,
} from '../adapter/csharpPropertySource';
import type { MaterialPropertyTarget } from './materialReferences';
import {
  CSHARP_PROPERTY_TYPE_MISMATCH_CODE,
  CSHARP_PROPERTY_UNCERTAIN_CODE,
  DIAGNOSTIC_SOURCE,
} from './diagnosticCodes';

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
  readonly nameOrigin: 'direct' | 'property-id';
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
  if (usage.nameOrigin === 'dynamic') return false;
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
export async function currentCSharpPropertyUsages<T extends CSharpPropertyUsage>(
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
): Promise<CSharpPropertyEvidenceLocation[]> {
  // Without an explicit current-source provider, no authoritative reference
  // can be produced. The production client has no C# document selector, so
  // the narrow current-source request bridge is the only authoritative source.
  if (!currentSourceProvider) return [];
  throwIfRequestCancelled(cancellation);
  const result = await provider.csharpPropertyUsagesFor({
    shaderName: target.shaderName,
    shaderPath: unityAssetPath(documentUri),
    propertyName: target.property.name,
  });
  throwIfRequestCancelled(cancellation);
  if (result.availability === 'unknown') return [];

  const current = await currentCSharpPropertyUsages(
    result.usages,
    currentSourceProvider,
    cancellation,
  );

  const authoritative = current
    .filter(isAuthoritativeUsage)
    .map((usage): CSharpPropertyReferenceLocation => ({
      uri: usage.uri,
      range: usage.range,
      data: {
        kind: 'csharp-property-usage',
        propertyName: usage.propertyName,
        propertyType: usage.propertyType,
        callKind: usage.callKind,
        accessor: usage.accessor,
        nameOrigin: usage.nameOrigin,
        receiverType: usage.receiverType,
        bindingDeterminism: 'proven',
        expressionDeterminism: usage.expressionDeterminism,
        shader: usage.shader,
        sourceRevision: usage.sourceRevision,
        provenance: usage.provenance,
      },
    }));
  const uncertain = current
    .filter((usage) => !isAuthoritativeUsage(usage))
    .map((usage): CSharpPropertyUncertainLocation => ({
      uri: usage.uri,
      range: usage.range,
      data: {
        kind: 'csharp-property-uncertain',
        propertyName: usage.propertyName,
        propertyType: usage.propertyType,
        callKind: usage.callKind,
        accessor: usage.accessor,
        nameOrigin: usage.nameOrigin,
        receiverType: usage.receiverType,
        bindingDeterminism: usage.bindingDeterminism,
        expressionDeterminism: usage.expressionDeterminism,
        shader: usage.shader,
        sourceRevision: usage.sourceRevision,
        uncertaintyReason: usage.bindingDeterminism !== 'proven'
          ? 'binding-not-proven'
          : 'dynamic-property-name',
        provenance: usage.provenance,
      },
    }));
  return [...authoritative, ...uncertain];
}

type AccessorContract = {
  readonly label: string;
  readonly propertyTypes: readonly ShaderLabPropertyType[];
};

function accessorContract(
  accessor: CSharpPropertyAccessor,
): AccessorContract | undefined {
  switch (accessor) {
    case 'property-to-id':
      return undefined;
    case 'set-color':
    case 'get-color':
      return { label: accessor === 'set-color' ? 'SetColor' : 'GetColor', propertyTypes: ['Color'] };
    case 'set-vector':
    case 'get-vector':
      return { label: accessor === 'set-vector' ? 'SetVector' : 'GetVector', propertyTypes: ['Vector'] };
    case 'set-float':
    case 'get-float':
      return {
        label: accessor === 'set-float' ? 'SetFloat' : 'GetFloat',
        propertyTypes: ['Float', 'Range'],
      };
    case 'set-int':
    case 'get-int':
      return { label: accessor === 'set-int' ? 'SetInt' : 'GetInt', propertyTypes: ['Int'] };
    case 'set-integer':
    case 'get-integer':
      return {
        label: accessor === 'set-integer' ? 'SetInteger' : 'GetInteger',
        propertyTypes: ['Integer'],
      };
    case 'set-texture':
    case 'get-texture':
      return {
        label: accessor === 'set-texture' ? 'SetTexture' : 'GetTexture',
        propertyTypes: ['2D', '2DArray', '3D', 'Cube', 'CubeArray'],
      };
  }
}

export function csharpAccessorCompatibility(
  accessor: CSharpPropertyAccessor,
  propertyType: ShaderLabPropertyType | null,
): 'compatible' | 'type-mismatch' | 'unknown' | 'not-applicable' {
  const contract = accessorContract(accessor);
  if (!contract) return 'not-applicable';
  if (!propertyType) return 'unknown';
  return contract.propertyTypes.includes(propertyType)
    ? 'compatible'
    : 'type-mismatch';
}

function uncertaintyMessage(
  data: CSharpPropertyUncertainData,
): string {
  return data.uncertaintyReason === 'binding-not-proven'
    ? 'C# usage has the same Property name, but Roslyn could not prove its Shader binding.'
    : 'C# usage may refer to this Property, but its name expression is dynamic.';
}

export async function csharpPropertyDiagnostics(
  documentUri: string,
  targets: readonly MaterialPropertyTarget[],
  provider: CSharpPropertyUsageProvider,
  currentSourceProvider: CSharpCurrentSourceProvider | undefined,
  cancellation?: CancellationToken,
): Promise<Diagnostic[]> {
  if (!currentSourceProvider) return [];
  const diagnostics: Diagnostic[] = [];
  for (const target of targets) {
    throwIfRequestCancelled(cancellation);
    const locations = await csharpPropertyReferences(
      documentUri,
      target,
      provider,
      currentSourceProvider,
      cancellation,
    );
    for (const location of locations) {
      if (location.data.kind === 'csharp-property-uncertain') {
        diagnostics.push({
          range: target.property.nameRange,
          severity: DiagnosticSeverity.Information,
          code: CSHARP_PROPERTY_UNCERTAIN_CODE,
          source: DIAGNOSTIC_SOURCE,
          message: uncertaintyMessage(location.data),
          relatedInformation: [{
            location: { uri: location.uri, range: location.range },
            message: 'Uncertain C# Shader Property evidence',
          }],
          data: {
            kind: 'csharp-property-uncertain',
            evidence: location.data,
          },
        });
        continue;
      }

      if (
        csharpAccessorCompatibility(location.data.accessor, target.property.type)
        !== 'type-mismatch'
      ) continue;
      const contract = accessorContract(location.data.accessor)!;
      diagnostics.push({
        range: target.property.nameRange,
        severity: DiagnosticSeverity.Warning,
        code: CSHARP_PROPERTY_TYPE_MISMATCH_CODE,
        source: DIAGNOSTIC_SOURCE,
        message: `${contract.label} is incompatible with Shader Property `
          + `'${target.property.name}' of type ${target.property.type}; expected `
          + `${contract.propertyTypes.join(' or ')}.`,
        relatedInformation: [{
          location: { uri: location.uri, range: location.range },
          message: `Proven C# ${contract.label} call`,
        }],
        data: {
          kind: 'csharp-property-type-mismatch',
          accessor: location.data.accessor,
          actualPropertyType: target.property.type,
          expectedPropertyTypes: contract.propertyTypes,
          evidence: location.data,
        },
      });
    }
  }
  return diagnostics;
}
