import { readFile } from 'node:fs/promises';
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

  const materialSource = await readCurrentSource(materialUri);
  if (materialSource.status !== 'available') {
    return unavailableMaterialContext(materialSource.reason);
  }
  const liveShaderSource = revision.sourceTextFor(shaderUri);
  const shaderSource = liveShaderSource !== undefined
    ? { status: 'available' as const, source: liveShaderSource }
    : await readCurrentSource(shaderUri);
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

async function readCurrentSource(uri: string): Promise<
  | { readonly status: 'available'; readonly source: string }
  | {
      readonly status: 'unavailable';
      readonly reason: 'asset-deleted' | 'source-unavailable';
    }
> {
  try {
    return { status: 'available', source: await readFile(fileURLToPath(uri), 'utf8') };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: isMissingFile(error) ? 'asset-deleted' : 'source-unavailable',
    };
  }
}

async function readCurrentAssetGuid(uri: string): Promise<string | undefined> {
  try {
    const meta = await readFile(`${fileURLToPath(uri)}.meta`, 'utf8');
    return /^guid:\s*([0-9a-f]{32})\s*$/im.exec(meta)?.[1].toLowerCase();
  } catch {
    return undefined;
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
