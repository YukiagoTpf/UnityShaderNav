import { createHash, randomUUID } from 'node:crypto';
import type {
  CSharpPropertyReferenceData,
  CSharpPropertyUsage,
  PropertyRenameBlocker,
  PropertyRenameManualFollowUp,
  PropertyRenameMaterialEdit,
  PropertyRenamePreview,
  PropertyRenamePreviewGroup,
  PropertyRenamePreviewResult,
  PropertyRenameSourceEdit,
  Range,
} from '@unity-shader-nav/shared';
import type { WorkspaceEdit } from 'vscode-languageserver/node';
import type {
  CSharpCurrentSourceProvider,
  CSharpPropertyUsageProvider,
} from '../adapter/csharpPropertySource';
import type {
  MaterialPropertyRenameProvider,
  MaterialPropertyRenameRequest,
  MaterialUsageProvider,
} from '../adapter/materialSource';
import { throwIfRequestCancelled } from '../lifecycle/requestCancellation';
import { uriKey } from '../uriKey';
import {
  currentCSharpPropertyEvidence,
  isAuthoritativeCSharpPropertyUsage,
} from './csharpPropertyReferences';
import type { DocumentPositionInput } from './indexedWorkspace';
import {
  materialPropertyCompatibility,
  materialPropertyTargetAt,
} from './materialReferences';
import type { WorkspaceNavigationState } from './navigation';
import { isRenameFailure } from './indexedWorkspace';
import { renameWorkspaceSymbol } from './rename';

export interface SafePropertyRenamePlan {
  readonly preview: PropertyRenamePreview;
  readonly sourceEdits: readonly PropertyRenameSourceEdit[];
  readonly materialRequest?: MaterialPropertyRenameRequest;
}

export type SafePropertyRenamePlanResult =
  | { readonly status: 'ready'; readonly plan: SafePropertyRenamePlan }
  | Extract<PropertyRenamePreviewResult, { readonly status: 'failure' }>;

interface SafePropertyRenameProviders {
  readonly materialUsages?: MaterialUsageProvider;
  readonly materialRenames?: MaterialPropertyRenameProvider;
  readonly csharpPropertyUsages?: CSharpPropertyUsageProvider;
  readonly csharpCurrentSource?: CSharpCurrentSourceProvider;
}

function offsetAt(text: string, position: Range['start']): number | undefined {
  if (position.line < 0 || position.character < 0) return undefined;
  let offset = 0;
  let line = 0;
  while (line < position.line) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return undefined;
    offset = newline + 1;
    line++;
  }
  const lineEnd = text.indexOf('\n', offset);
  const contentEnd = lineEnd < 0 ? text.length : lineEnd;
  const withoutCarriageReturn = contentEnd > offset && text[contentEnd - 1] === '\r'
    ? contentEnd - 1
    : contentEnd;
  if (offset + position.character > withoutCarriageReturn) return undefined;
  return offset + position.character;
}

function textInRange(text: string, range: Range): string | undefined {
  const start = offsetAt(text, range.start);
  const end = offsetAt(text, range.end);
  if (start === undefined || end === undefined || end < start) return undefined;
  return text.slice(start, end);
}

function packageUri(uri: string): boolean {
  try {
    return /(?:^|\/)Packages\//.test(new URL(uri).pathname);
  } catch {
    return /(?:^|[\\/])Packages[\\/]/.test(uri);
  }
}

function csharpReferenceData(
  usage: CSharpPropertyUsage & {
    readonly bindingDeterminism: 'proven';
    readonly expressionDeterminism: 'constant-string' | 'constant-concat';
    readonly nameOrigin: 'direct' | 'property-id';
    readonly shader: NonNullable<CSharpPropertyUsage['shader']>;
  },
): CSharpPropertyReferenceData {
  return {
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
  };
}

function sourceEditKey(edit: Pick<PropertyRenameSourceEdit, 'uri' | 'range'>): string {
  return [
    uriKey(edit.uri),
    edit.range.start.line,
    edit.range.start.character,
    edit.range.end.line,
    edit.range.end.character,
  ].join(':');
}

function sortSourceEdits(edits: PropertyRenameSourceEdit[]): void {
  edits.sort((left, right) => (
    left.uri.localeCompare(right.uri)
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.range.end.line - right.range.end.line
    || left.range.end.character - right.range.end.character
  ));
}

function groupPreviewItems(
  shaderEdits: readonly PropertyRenameSourceEdit[],
  csharpEdits: readonly PropertyRenameSourceEdit[],
  materialEdits: readonly PropertyRenameMaterialEdit[],
): PropertyRenamePreviewGroup[] {
  const groups: PropertyRenamePreviewGroup[] = [];
  if (shaderEdits.length > 0) {
    groups.push({
      kind: 'shader-source',
      label: 'ShaderLab / HLSL source',
      items: shaderEdits,
    });
  }
  if (csharpEdits.length > 0) {
    groups.push({
      kind: 'csharp-source',
      label: 'Proven C# source',
      items: csharpEdits,
    });
  }
  if (materialEdits.length > 0) {
    groups.push({
      kind: 'material-asset',
      label: 'Serialized Material assets',
      items: materialEdits,
    });
  }
  return groups;
}

function previewIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function workspaceChanges(edit: WorkspaceEdit): NonNullable<WorkspaceEdit['changes']> {
  return edit.changes ?? {};
}

export async function planSafePropertyRename(
  state: WorkspaceNavigationState,
  input: DocumentPositionInput & { readonly newName: string },
  providers: SafePropertyRenameProviders,
): Promise<SafePropertyRenamePlanResult> {
  throwIfRequestCancelled(input.cancellation);
  const index = state.index.store.get(input.document.uri);
  const target = materialPropertyTargetAt(index, input.position);
  if (!target) {
    return {
      status: 'failure',
      message: 'Safe cross-asset Rename is available only for one ShaderLab Property contract.',
    };
  }

  const base = await renameWorkspaceSymbol(state, input);
  if (!base || isRenameFailure(base)) {
    return {
      status: 'failure',
      message: isRenameFailure(base)
        ? base.message
        : `No editable occurrences were found for '${target.property.name}'.`,
    };
  }

  const oldName = target.property.name;
  const blockers: PropertyRenameBlocker[] = [];
  const manualFollowUps: PropertyRenameManualFollowUp[] = [];
  const shaderEdits: PropertyRenameSourceEdit[] = [];
  for (const [uri, edits] of Object.entries(workspaceChanges(base))) {
    for (const edit of edits) {
      const oldText = uriKey(uri) === uriKey(input.document.uri)
        ? textInRange(input.document.text, edit.range)
        : undefined;
      if (oldText !== oldName) {
        blockers.push({
          code: 'source-conflict',
          message: `Indexed source no longer contains '${oldName}' at the planned edit.`,
          uri,
          range: edit.range,
        });
        continue;
      }
      shaderEdits.push({
        kind: 'source-edit',
        group: 'shader-source',
        uri,
        range: edit.range,
        oldText,
        newText: input.newName,
        provenance: { kind: 'published-index' },
      });
    }
  }
  sortSourceEdits(shaderEdits);

  let materialRevision: string | undefined;
  const materialEdits: PropertyRenameMaterialEdit[] = [];
  let materialRequest: MaterialPropertyRenameRequest | undefined;
  if (!providers.materialUsages) {
    blockers.push({
      code: 'adapter-unavailable',
      message: 'Material asset scope is unavailable; serialized Property names cannot be proven.',
    });
  } else {
    const usage = await providers.materialUsages.materialsUsingShader({
      name: target.shaderName,
      path: (() => {
        try {
          const pathname = new URL(input.document.uri).pathname;
          return /(?:^|\/)((?:Assets|Packages)\/.*)$/.exec(pathname)?.[1] ?? pathname;
        } catch {
          return input.document.uri;
        }
      })(),
    });
    throwIfRequestCancelled(input.cancellation);
    if (usage.availability === 'unknown') {
      blockers.push({
        code: 'adapter-unavailable',
        message: `Material asset scope is unknown (${usage.reason}).`,
      });
    } else {
      materialRevision = usage.revision;
      for (const material of usage.materials) {
        const property = material.properties.find((candidate) => (
          candidate.name === oldName
        ));
        if (!property) continue;
        if (/^Packages[\\/]/.test(material.path)) {
          blockers.push({
            code: 'read-only-package',
            message: `Material '${material.path}' is in a read-only Unity Package.`,
          });
          continue;
        }
        materialEdits.push({
          kind: 'material-asset-edit',
          group: 'material-asset',
          guid: material.guid,
          path: material.path,
          oldName,
          newName: input.newName,
          provenance: material.provenance,
        });
        if (
          materialPropertyCompatibility(target.property.type, property.type)
          === 'type-mismatch'
        ) {
          manualFollowUps.push({
            path: material.path,
            message: `Existing serialized value type for '${material.path}' already disagrees with the Shader Property contract.`,
          });
        }
      }
      manualFollowUps.push({
        message: 'Runtime-created Materials remain outside complete AssetDatabase evidence.',
      });
      materialEdits.sort((left, right) => (
        left.guid.localeCompare(right.guid) || left.path.localeCompare(right.path)
      ));
      if (materialEdits.length > 0) {
        const renameAvailability = providers.materialRenames
          ?.materialPropertyRenameAvailability();
        if (!renameAvailability?.available) {
          blockers.push({
            code: 'unsupported-asset-update',
            message: renameAvailability?.reason
              ?? 'Transactional Material Property updates are unavailable.',
          });
        } else {
          materialRequest = {
            shader: {
              name: target.shaderName,
              path: (() => {
                try {
                  const pathname = new URL(input.document.uri).pathname;
                  return /(?:^|\/)((?:Assets|Packages)\/.*)$/.exec(pathname)?.[1] ?? pathname;
                } catch {
                  return input.document.uri;
                }
              })(),
            },
            oldName,
            newName: input.newName,
            expectedRevision: usage.revision,
            assets: materialEdits.map(({ guid, path }) => ({ guid, path })),
          };
        }
      }
    }
  }

  const csharpEdits: PropertyRenameSourceEdit[] = [];
  if (!providers.csharpPropertyUsages || !providers.csharpCurrentSource) {
    blockers.push({
      code: 'adapter-unavailable',
      message: 'C# Property usage scope or exact current C# source is unavailable.',
    });
  } else {
    const result = await providers.csharpPropertyUsages.csharpPropertyUsagesFor({
      shaderName: target.shaderName,
      shaderPath: materialRequest?.shader.path ?? (() => {
        try {
          const pathname = new URL(input.document.uri).pathname;
          return /(?:^|\/)((?:Assets|Packages)\/.*)$/.exec(pathname)?.[1] ?? pathname;
        } catch {
          return input.document.uri;
        }
      })(),
      propertyName: oldName,
    });
    throwIfRequestCancelled(input.cancellation);
    if (result.availability === 'unknown') {
      blockers.push({
        code: 'adapter-unavailable',
        message: `C# Property usage scope is unknown (${result.reason}).`,
      });
    } else {
      const current = await currentCSharpPropertyEvidence(
        result.usages,
        providers.csharpCurrentSource,
        input.cancellation,
      );
      const currentByUsage = new Map(current.map((entry) => [entry.usage, entry.text]));
      for (const usage of result.usages) {
        const text = currentByUsage.get(usage);
        if (text === undefined) {
          blockers.push({
            code: 'source-conflict',
            message: `C# evidence for '${usage.uri}' is stale or its current source is unavailable.`,
            uri: usage.uri,
            range: usage.range,
          });
          continue;
        }
        if (!isAuthoritativeCSharpPropertyUsage(usage)) {
          blockers.push({
            code: usage.expressionDeterminism === 'dynamic'
              ? 'dynamic-reference'
              : 'ambiguous-evidence',
            message: usage.expressionDeterminism === 'dynamic'
              ? 'A dynamic C# Property-name expression cannot be renamed mechanically.'
              : 'A C# Property usage is not proven to belong to the selected Shader.',
            uri: usage.uri,
            range: usage.range,
          });
          continue;
        }
        if (state.isInPackages(usage.uri) || packageUri(usage.uri)) {
          blockers.push({
            code: 'read-only-package',
            message: `C# Property usage '${usage.uri}' is in a read-only Unity Package.`,
            uri: usage.uri,
            range: usage.range,
          });
          continue;
        }
        const editableName = textInRange(text, usage.range);
        const ownsNameToken = usage.callKind === 'property-to-id'
          || usage.nameOrigin === 'direct';
        if (!ownsNameToken) continue;
        if (editableName !== oldName) {
          blockers.push({
            code: 'source-conflict',
            message: `C# source does not contain the exact Property name at the proven range.`,
            uri: usage.uri,
            range: usage.range,
          });
          continue;
        }
        csharpEdits.push({
          kind: 'source-edit',
          group: 'csharp-source',
          uri: usage.uri,
          range: usage.range,
          oldText: editableName,
          newText: input.newName,
          provenance: {
            kind: 'csharp-adapter',
            evidence: csharpReferenceData(usage),
          },
        });
      }
      const hasPropertyIdFlow = result.usages.some((usage) => (
        usage.nameOrigin === 'property-id' && usage.callKind !== 'property-to-id'
      ));
      const hasEditablePropertyIdOrigin = csharpEdits.some((edit) => (
        edit.provenance.kind === 'csharp-adapter'
        && edit.provenance.evidence.callKind === 'property-to-id'
      ));
      if (hasPropertyIdFlow && !hasEditablePropertyIdOrigin) {
        blockers.push({
          code: 'source-conflict',
          message: 'A proven PropertyToID-derived call has no editable constant name origin.',
        });
      }
    }
  }

  const dedupedCSharp = [...new Map(
    csharpEdits.map((edit) => [sourceEditKey(edit), edit]),
  ).values()];
  sortSourceEdits(dedupedCSharp);
  blockers.sort((left, right) => (
    left.code.localeCompare(right.code)
    || (left.uri ?? '').localeCompare(right.uri ?? '')
    || left.message.localeCompare(right.message)
  ));
  manualFollowUps.sort((left, right) => (
    (left.path ?? '').localeCompare(right.path ?? '')
    || left.message.localeCompare(right.message)
  ));

  const groups = groupPreviewItems(shaderEdits, dedupedCSharp, materialEdits);
  const identity = {
    oldName,
    newName: input.newName,
    groups,
    blockers,
    manualFollowUps,
    materialRevision,
  };
  const preview: PropertyRenamePreview = {
    previewId: previewIdentity(identity),
    oldName,
    newName: input.newName,
    groups,
    blockers,
    manualFollowUps,
    canApply: blockers.length === 0,
  };
  return {
    status: 'ready',
    plan: {
      preview,
      sourceEdits: [...shaderEdits, ...dedupedCSharp],
      ...(materialRequest ? { materialRequest } : {}),
    },
  };
}

export function createPropertyRenameTransactionId(): string {
  return randomUUID();
}
