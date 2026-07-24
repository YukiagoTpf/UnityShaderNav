import { uriIdentityKey } from '@unity-shader-nav/shared';
import type { FileIdentityOptions } from './fileIdentity';

/** Canonical identity for file URIs used across registries and indexes. */
export function uriKey(uri: string, options: FileIdentityOptions = {}): string {
  return uriIdentityKey(uri, options);
}
