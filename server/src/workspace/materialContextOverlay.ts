import type {
  MaterialSerializedValue,
  SelectedMaterialContext,
} from '@unity-shader-nav/shared';
import type {
  CompletionItem,
  Location,
  LocationLink,
} from 'vscode-languageserver/node';
import { uriKey } from '../uriKey';

/** Additive annotation/ranking only: every conservative item is retained. */
export function annotateMaterialCompletions(
  items: readonly CompletionItem[],
  context: SelectedMaterialContext,
): CompletionItem[] {
  const properties = new Map(context.properties.map((property) => [
    property.name,
    `Material ${context.material.name} override: ${formatValue(property.serializedValue)}`,
  ]));
  const textures = new Map(context.textures.map((binding) => [
    binding.propertyName,
    `Material ${context.material.name} texture: ${binding.texture?.name ?? 'None'}`,
  ]));
  const keywords = new Map(context.keywords.material.map((keyword) => [
    keyword.name,
    `Material keyword ${keyword.enabled ? 'enabled' : 'disabled'} (${keyword.scope})`,
  ]));

  return items.map((item) => {
    const label = item.label;
    const annotation = properties.get(label)
      ?? textures.get(label)
      ?? keywords.get(label);
    const priorSort = item.sortText ?? label;
    if (!annotation) {
      return { ...item, sortText: `1_conservative_${priorSort}` };
    }
    return {
      ...item,
      detail: [item.detail, annotation].filter(Boolean).join(' · '),
      sortText: `0_material_${priorSort}`,
      data: {
        ...(isRecord(item.data) ? item.data : {}),
        materialContext: {
          selectionId: context.selectionId,
          material: {
            name: context.material.name,
            path: context.material.path,
            assetGuid: context.material.revision.assetGuid,
          },
          provenance: context.provenance,
        },
      },
    };
  });
}

/** Stable partition only; no conservative navigation candidate is removed. */
export function rankMaterialDefinitionCandidates<
  T extends Location | LocationLink,
>(
  candidates: readonly T[],
  context: SelectedMaterialContext,
): T[] {
  const shaderKey = uriKey(context.shader.revision.uri);
  const matching: T[] = [];
  const conservative: T[] = [];
  for (const candidate of candidates) {
    const targetUri = 'targetUri' in candidate ? candidate.targetUri : candidate.uri;
    (uriKey(targetUri) === shaderKey ? matching : conservative).push(candidate);
  }
  return [...matching, ...conservative];
}

function formatValue(value: MaterialSerializedValue): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, nested]) => (
      `${key}: ${formatValue(nested)}`
    )).join(', ')} }`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
