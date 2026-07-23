import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathIdentity } from '../../pathIdentity';
import {
  ADAPTER_PROTOCOL_VERSION,
  type AdapterEndpointKind,
  type AdapterSessionDescriptor,
} from './protocol';

export const ADAPTER_SESSION_RELATIVE_PATH = join(
  'Library',
  'UnityShaderNavAdapter',
  'session.json',
);

const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;

export type AdapterDescriptorUnavailableReason =
  | 'missing'
  | 'invalid'
  | 'foreign-project'
  | 'version-incompatible';

export type AdapterDescriptorDiscovery =
  | {
      readonly status: 'available';
      readonly path: string;
      readonly descriptor: AdapterSessionDescriptor;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: AdapterDescriptorUnavailableReason;
    };

export function canonicalProjectIdentity(unityRoot: string): string {
  return pathIdentity(unityRoot);
}

export function unityProjectHash(unityRoot: string): string {
  return createHash('sha256')
    .update(canonicalProjectIdentity(unityRoot), 'utf8')
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validEndpoint(
  kind: AdapterEndpointKind,
  endpoint: unknown,
  platform: NodeJS.Platform,
): endpoint is string {
  if (!nonEmptyString(endpoint)) return false;
  if (kind === 'named-pipe') {
    return platform === 'win32' && /^\\\\\.\\pipe\\[^\\/]+$/.test(endpoint);
  }
  return platform !== 'win32' && isAbsolute(endpoint);
}

export function decodeAdapterSessionDescriptor(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): AdapterSessionDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.endpointKind !== 'named-pipe'
    && value.endpointKind !== 'unix-domain-socket'
  ) return undefined;
  if (
    !Number.isInteger(value.protocolVersion)
    || !nonEmptyString(value.adapterVersion)
    || !nonEmptyString(value.unityVersion)
    || !nonEmptyString(value.projectHash)
    || !SHA256.test(value.projectHash)
    || !nonEmptyString(value.instanceId)
    || !validEndpoint(value.endpointKind, value.endpoint, platform)
    || !nonEmptyString(value.token)
    || !TOKEN.test(value.token)
    || !Number.isSafeInteger(value.processId)
    || Number(value.processId) <= 0
  ) return undefined;

  return {
    protocolVersion: Number(value.protocolVersion),
    adapterVersion: value.adapterVersion,
    unityVersion: value.unityVersion,
    projectHash: value.projectHash,
    instanceId: value.instanceId,
    endpointKind: value.endpointKind,
    endpoint: value.endpoint,
    token: value.token,
    processId: Number(value.processId),
  };
}

export async function discoverAdapterSession(
  unityRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<AdapterDescriptorDiscovery> {
  const descriptorPath = join(unityRoot, ADAPTER_SESSION_RELATIVE_PATH);
  let info;
  try {
    info = await lstat(descriptorPath);
  } catch {
    return { status: 'unavailable', reason: 'missing' };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DESCRIPTOR_BYTES) {
    return { status: 'unavailable', reason: 'invalid' };
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(descriptorPath, 'utf8'));
  } catch {
    return { status: 'unavailable', reason: 'invalid' };
  }
  const descriptor = decodeAdapterSessionDescriptor(value, platform);
  if (!descriptor) return { status: 'unavailable', reason: 'invalid' };
  if (descriptor.protocolVersion !== ADAPTER_PROTOCOL_VERSION) {
    return { status: 'unavailable', reason: 'version-incompatible' };
  }
  if (descriptor.projectHash !== unityProjectHash(unityRoot)) {
    return { status: 'unavailable', reason: 'foreign-project' };
  }
  return { status: 'available', path: descriptorPath, descriptor };
}
