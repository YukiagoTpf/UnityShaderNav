import { createHash } from 'node:crypto';
import {
  CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
  type CSharpPropertyAccessor,
  type CSharpPropertyUsage,
  type ShaderLabPropertyType,
} from '@unity-shader-nav/shared';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { describe, expect, it } from 'vitest';
import type {
  CSharpCurrentSourceProvider,
  CSharpPropertyUsageProvider,
} from '../../src/adapter/csharpPropertySource';
import {
  csharpAccessorCompatibility,
  csharpPropertyDiagnostics,
} from '../../src/workspace/csharpPropertyReferences';
import {
  CSHARP_PROPERTY_TYPE_MISMATCH_CODE,
  CSHARP_PROPERTY_UNCERTAIN_CODE,
} from '../../src/workspace/diagnosticCodes';
import type { MaterialPropertyTarget } from '../../src/workspace/materialReferences';

const shaderUri = 'file:///project/Assets/Shaders/Lit.shader';
const csUri = 'file:///project/Assets/Scripts/Controller.cs';
const csText = 'material.SetFloat("_Tint", 1);';

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function target(type: ShaderLabPropertyType | null = 'Color'): MaterialPropertyTarget {
  return {
    shaderName: 'Tests/Lit',
    property: {
      name: '_Tint',
      type,
      nameRange: {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 9 },
      },
      declarationRange: {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 40 },
      },
    },
  };
}

function usage(
  overrides: Partial<CSharpPropertyUsage> = {},
): CSharpPropertyUsage {
  return {
    uri: csUri,
    range: {
      start: { line: 0, character: 19 },
      end: { line: 0, character: 24 },
    },
    propertyName: '_Tint',
    propertyType: 'Color',
    callKind: 'material-set',
    accessor: 'set-float',
    nameOrigin: 'direct',
    receiverType: 'Material',
    expressionDeterminism: 'constant-string',
    bindingDeterminism: 'proven',
    shader: { name: 'Tests/Lit', path: 'Assets/Shaders/Lit.shader' },
    sourceRevision: { uri: csUri, contentHash: hash(csText) },
    provenance: {
      capability: CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
      adapterVersion: '0.2.0',
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      instanceId: 'editor-1',
      collectedAt: 1000,
      sourceRevision: 'csharp-1',
    },
    ...overrides,
  };
}

function provider(usages: readonly CSharpPropertyUsage[]): CSharpPropertyUsageProvider {
  return {
    async csharpPropertyUsagesFor() {
      return {
        availability: 'available',
        assetScope: 'complete',
        revision: 'csharp-1',
        usages,
      };
    },
  };
}

function currentSource(text = csText): CSharpCurrentSourceProvider {
  return {
    async currentSourceFor(uri) {
      return uri === csUri ? { text, availability: 'open-buffer' } : null;
    },
  };
}

describe('C# Shader Property accessor compatibility', () => {
  it.each<[
    CSharpPropertyAccessor,
    ShaderLabPropertyType,
    ReturnType<typeof csharpAccessorCompatibility>,
  ]>([
    ['set-color', 'Color', 'compatible'],
    ['get-vector', 'Vector', 'compatible'],
    ['set-float', 'Range', 'compatible'],
    ['get-int', 'Int', 'compatible'],
    ['set-integer', 'Integer', 'compatible'],
    ['get-texture', 'CubeArray', 'compatible'],
    ['set-float', 'Color', 'type-mismatch'],
    ['set-integer', 'Int', 'type-mismatch'],
    ['property-to-id', 'Color', 'not-applicable'],
  ])('%s against %s is %s', (accessor, propertyType, expected) => {
    expect(csharpAccessorCompatibility(accessor, propertyType)).toBe(expected);
  });

  it('keeps an unrecognized Shader Property type neutral', () => {
    expect(csharpAccessorCompatibility('set-color', null)).toBe('unknown');
  });
});

describe('C# Shader Property diagnostics', () => {
  it('reports a focused mismatch with the proven C# call as related evidence', async () => {
    const diagnostics = await csharpPropertyDiagnostics(
      shaderUri,
      [target('Color')],
      provider([usage()]),
      currentSource(),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: DiagnosticSeverity.Warning,
      code: CSHARP_PROPERTY_TYPE_MISMATCH_CODE,
      range: target().property.nameRange,
      relatedInformation: [{
        location: { uri: csUri, range: usage().range },
      }],
    });
    expect(diagnostics[0].message).toContain('SetFloat');
    expect(diagnostics[0].message).toContain('Color');
    expect(diagnostics[0].message).toContain('Float or Range');
  });

  it('does not diagnose a compatible accessor or PropertyToID origin', async () => {
    const diagnostics = await csharpPropertyDiagnostics(
      shaderUri,
      [target('Color')],
      provider([
        usage({ accessor: 'set-color' }),
        usage({
          callKind: 'property-to-id',
          accessor: 'property-to-id',
          receiverType: 'Shader',
        }),
      ]),
      currentSource(),
    );

    expect(diagnostics).toEqual([]);
  });

  it('surfaces fresh name-only evidence as informational and non-authoritative', async () => {
    const diagnostics = await csharpPropertyDiagnostics(
      shaderUri,
      [target('Color')],
      provider([usage({
        bindingDeterminism: 'name-only',
        shader: null,
      })]),
      currentSource(),
    );

    expect(diagnostics).toMatchObject([{
      severity: DiagnosticSeverity.Information,
      code: CSHARP_PROPERTY_UNCERTAIN_CODE,
      data: {
        kind: 'csharp-property-uncertain',
        evidence: {
          uncertaintyReason: 'binding-not-proven',
        },
      },
    }]);
  });

  it('rejects stale positions before producing mismatch or uncertainty diagnostics', async () => {
    const diagnostics = await csharpPropertyDiagnostics(
      shaderUri,
      [target('Color')],
      provider([usage()]),
      currentSource(`${csText}\n// edited`),
    );

    expect(diagnostics).toEqual([]);
  });
});
