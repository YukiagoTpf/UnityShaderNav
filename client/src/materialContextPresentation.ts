import type {
  MaterialContextResult,
  MaterialSerializedValue,
} from '@unity-shader-nav/shared';

type AvailableMaterialContext = Extract<
  MaterialContextResult,
  { readonly status: 'available' }
>;

export interface MaterialContextDetail {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface MaterialContextStatusPresentation {
  readonly text: string;
  readonly tooltip: string;
}

export function materialContextStatus(
  result: AvailableMaterialContext,
): MaterialContextStatusPresentation {
  const details = materialContextDetails(result);
  return {
    text: `$(symbol-color) Material: ${result.context.material.name}`,
    tooltip: details.map((item) => (
      [stripIcon(item.label), item.description, item.detail]
        .filter((part): part is string => !!part)
        .join(' · ')
    )).join('\n'),
  };
}

export function materialContextDetails(
  result: AvailableMaterialContext,
): MaterialContextDetail[] {
  const { context } = result;
  const program = context.selectedProgram
    ? [
        `SubShader ${context.selectedProgram.subShaderIndex + 1}`,
        ...(context.selectedProgram.passIndex !== undefined
          ? [`Pass ${context.selectedProgram.passIndex + 1}${
            context.selectedProgram.passName
              ? ` "${context.selectedProgram.passName}"`
              : ''
          }`]
          : []),
      ].join(' · ')
    : 'unknown';
  const details: MaterialContextDetail[] = [
    {
      label: '$(warning) Material Context is not the final draw Context',
      detail: 'Draw-specific global and engine-added keyword evidence is unavailable.',
    },
    {
      label: `$(symbol-color) Material: ${context.material.name}`,
      description: context.material.path,
      detail: `asset ${context.material.revision.assetGuid} · revision ${shortHash(
        context.material.revision.contentHash,
      )}`,
    },
    {
      label: `$(symbol-class) Shader: ${context.shader.name}`,
      description: context.shader.path,
      detail: `asset ${context.shader.revision.assetGuid} · revision ${shortHash(
        context.shader.revision.contentHash,
      )}`,
    },
    {
      label: `$(symbol-method) Program: ${program}`,
      description: context.selectedProgram ? 'Adapter-selected source program' : 'unknown',
    },
  ];

  if (context.properties.length === 0) {
    details.push({ label: '$(symbol-field) Serialized Properties: none' });
  } else {
    for (const property of context.properties) details.push({
      label: `$(symbol-field) Property ${property.name}`,
      description: property.type,
      detail: formatSerializedValue(property.serializedValue),
    });
  }

  if (context.textures.length === 0) {
    details.push({ label: '$(file-media) Textures: none' });
  } else {
    for (const binding of context.textures) details.push({
      label: `$(file-media) Texture ${binding.propertyName}`,
      description: binding.texture?.name ?? 'None',
      detail: binding.texture
        ? `${binding.texture.path} · asset ${binding.texture.guid}`
        : 'No texture assigned',
    });
  }

  if (context.keywords.material.length === 0) {
    details.push({ label: '$(key) Material keywords: none enabled or serialized' });
  } else {
    for (const keyword of context.keywords.material) details.push({
      label: `$(key) Material keyword ${keyword.name}`,
      description: keyword.enabled ? 'enabled' : 'disabled',
      detail: `${keyword.scope} keyword evidence`,
    });
  }
  details.push(
    {
      label: '$(question) Global keywords: unknown',
      detail: 'Actual draw evidence is required.',
    },
    {
      label: '$(question) Engine-added keywords: unknown',
      detail: 'Actual draw evidence is required.',
    },
    {
      label: '$(verified) Adapter provenance',
      description: `Unity ${context.provenance.unityVersion} · Adapter ${
        context.provenance.adapterVersion
      }`,
      detail: [
        `project ${context.provenance.projectId}`,
        `instance ${context.provenance.instanceId}`,
        `selection ${context.selectionId}`,
        `published revision ${result.revision}`,
      ].join(' · '),
    },
  );
  return details;
}

function formatSerializedValue(value: MaterialSerializedValue): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return `[${value.map(formatSerializedValue).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, nested]) => (
      `${key}: ${formatSerializedValue(nested)}`
    )).join(', ')} }`;
  }
  return JSON.stringify(value);
}

function shortHash(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function stripIcon(value: string): string {
  return value.replace(/^\$\([^)]+\)\s*/, '');
}
