import type { FileIndex } from '@unity-shader-nav/shared';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isOptionalRecordArray(value: unknown): boolean {
  return value === undefined || isRecordArray(value);
}

function hasRecordArray(value: unknown, field: string): boolean {
  return isRecord(value) && isRecordArray(value[field]);
}

function hasMaterialContainers(value: unknown): boolean {
  if (
    !isRecord(value)
    || !isRecordArray(value.cbuffers)
    || !isRecordArray(value.programBlocks)
  ) return false;
  return value.cbuffers.every((cbuffer) => hasRecordArray(cbuffer, 'fields'));
}

/**
 * Apply only the shallow checks required to consume a same-fingerprint cache.
 * Release/schema/grammar/settings/macro compatibility owns semantic validity;
 * this seam rejects broken JSON containers without duplicating FileIndex types.
 */
export function decodePersistedFileIndex(
  value: unknown,
  expectedUri: string,
): FileIndex | null {
  if (
    !isRecord(value)
    || value.uri !== expectedUri
    || !isRecordArray(value.symbols)
    || !isRecordArray(value.references)
    || !isOptionalRecordArray(value.typeInferences)
    || !isOptionalRecordArray(value.properties)
    || !(value.structure === undefined || hasRecordArray(value.structure, 'shaders'))
    || !(value.shaderLabNames === undefined
      || (hasRecordArray(value.shaderLabNames, 'shaders')
        && hasRecordArray(value.shaderLabNames, 'passes')
        && hasRecordArray(value.shaderLabNames, 'references')))
    || !(value.shaderLabMaterial === undefined
      || hasMaterialContainers(value.shaderLabMaterial))
  ) return null;

  return value as unknown as FileIndex;
}
