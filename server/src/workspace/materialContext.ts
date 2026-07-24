import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  FileIndex,
  MaterialContextResult,
  MaterialContextUnavailableReason,
  SelectedMaterialContext,
} from '@unity-shader-nav/shared';
import { sourceHash } from '../sourceHash';
import { uriKey } from '../uriKey';
import { containsPath } from './pathUtils';

export const MAX_MATERIAL_CONTEXT_MATERIAL_BYTES = 4 * 1_024 * 1_024;
export const MAX_MATERIAL_CONTEXT_SHADER_BYTES = 4 * 1_024 * 1_024;
export const MAX_MATERIAL_CONTEXT_META_BYTES = 64 * 1_024;

export interface MaterialContextRevisionView {
  readonly folderUri: string;
  readonly revision: number;
  readonly publicationId: string;
  readonly unityRoot: string | undefined;
  sourceTextFor(uri: string): string | undefined;
  indexedFile(uri: string): FileIndex | undefined;
}

export function unavailableMaterialContext(
  reason: MaterialContextUnavailableReason,
): MaterialContextResult {
  return { status: 'unavailable', reason };
}

export async function validateMaterialContext(
  revision: MaterialContextRevisionView,
  context: SelectedMaterialContext,
): Promise<MaterialContextResult> {
  const unityRoot = revision.unityRoot;
  if (!unityRoot) return unavailableMaterialContext('source-unavailable');

  const materialUri = resolveAssetUri(unityRoot, context.material.path);
  const shaderUri = resolveAssetUri(unityRoot, context.shader.path);
  if (
    !materialUri
    || !shaderUri
    || uriKey(materialUri) !== uriKey(context.material.revision.uri)
    || uriKey(shaderUri) !== uriKey(context.shader.revision.uri)
  ) {
    return unavailableMaterialContext('invalid-evidence');
  }

  const shaderIndex = revision.indexedFile(shaderUri);
  if (!shaderIndex?.shaderLabNames?.shaders.some(({ name }) => (
    name === context.shader.name
  ))) {
    return unavailableMaterialContext('stale-source');
  }

  const materialSource = await readCurrentSource(
    materialUri,
    MAX_MATERIAL_CONTEXT_MATERIAL_BYTES,
  );
  if (materialSource.status !== 'available') {
    return unavailableMaterialContext(materialSource.reason);
  }
  const liveShaderSource = revision.sourceTextFor(shaderUri);
  const shaderSource = liveShaderSource !== undefined
    ? currentSourceFromText(
        liveShaderSource,
        MAX_MATERIAL_CONTEXT_SHADER_BYTES,
      )
    : await readCurrentSource(
        shaderUri,
        MAX_MATERIAL_CONTEXT_SHADER_BYTES,
      );
  if (shaderSource.status !== 'available') {
    return unavailableMaterialContext(shaderSource.reason);
  }
  if (
    sourceHash(materialSource.source) !== context.material.revision.contentHash
    || sourceHash(shaderSource.source) !== context.shader.revision.contentHash
  ) {
    return unavailableMaterialContext('stale-source');
  }

  const [materialGuid, shaderGuid] = await Promise.all([
    readCurrentAssetGuid(materialUri),
    readCurrentAssetGuid(shaderUri),
  ]);
  if (materialGuid === undefined || shaderGuid === undefined) {
    return unavailableMaterialContext('source-unavailable');
  }
  if (
    materialGuid !== context.material.revision.assetGuid.toLowerCase()
    || shaderGuid !== context.shader.revision.assetGuid.toLowerCase()
  ) {
    return unavailableMaterialContext('stale-source');
  }

  return {
    status: 'available',
    folderUri: revision.folderUri,
    revision: revision.revision,
    publicationId: revision.publicationId,
    context,
  };
}

function resolveAssetUri(unityRoot: string, assetPath: string): string | undefined {
  const normalized = assetPath.replace(/\\/g, '/');
  if (!/^(?:Assets|Packages)\//.test(normalized)) return undefined;
  const absolute = resolve(unityRoot, normalized);
  if (!containsPath(unityRoot, absolute)) return undefined;
  return pathToFileURL(absolute).href;
}

type CurrentSource =
  | { readonly status: 'available'; readonly source: string }
  | {
      readonly status: 'unavailable';
      readonly reason: 'asset-deleted' | 'source-unavailable';
    };

function currentSourceFromText(source: string, maxBytes: number): CurrentSource {
  return Buffer.byteLength(source, 'utf8') <= maxBytes
    ? { status: 'available', source }
    : { status: 'unavailable', reason: 'source-unavailable' };
}

async function readCurrentSource(
  uri: string,
  maxBytes: number,
): Promise<CurrentSource> {
  const result = await readBoundedUtf8File(fileURLToPath(uri), maxBytes);
  if (result.status === 'available') {
    return { status: 'available', source: result.text };
  }
  return {
    status: 'unavailable',
    reason: result.reason === 'missing'
      ? 'asset-deleted'
      : 'source-unavailable',
  };
}

async function readCurrentAssetGuid(uri: string): Promise<string | undefined> {
  const result = await readBoundedUtf8File(
    `${fileURLToPath(uri)}.meta`,
    MAX_MATERIAL_CONTEXT_META_BYTES,
  );
  if (result.status !== 'available') return undefined;
  return /^guid:\s*([0-9a-f]{32})\s*$/im.exec(result.text)?.[1].toLowerCase();
}

type BoundedTextRead =
  | { readonly status: 'available'; readonly text: string }
  | {
      readonly status: 'unavailable';
      readonly reason: 'missing' | 'unavailable';
    };

async function readBoundedUtf8File(
  path: string,
  maxBytes: number,
): Promise<BoundedTextRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      return { status: 'unavailable', reason: 'unavailable' };
    }

    const bytes = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > size) {
      return { status: 'unavailable', reason: 'unavailable' };
    }
    return {
      status: 'available',
      text: bytes.subarray(0, offset).toString('utf8'),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: isMissingFile(error) ? 'missing' : 'unavailable',
    };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
