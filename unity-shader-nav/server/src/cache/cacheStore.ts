import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  CACHE_VERSION,
  type CachedFile,
  type CacheFingerprint,
  type CacheManifest,
  type FileIndex,
  type FunctionParameter,
  type ReferenceContext,
  type SymbolKind,
} from '@unity-shader-nav/shared';
import { fingerprintsEqual } from './fingerprint';

const symbolKinds = new Set<SymbolKind>([
  'function',
  'variable',
  'parameter',
  'localVariable',
  'struct',
  'structMember',
  'macro',
  'cbuffer',
]);

const referenceContexts = new Set<ReferenceContext>([
  'call',
  'type',
  'member',
  'pragma',
  'identifier',
  'include',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPosition(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNumber(value.line)
    && isFiniteNumber(value.character);
}

function isRange(value: unknown): boolean {
  return isRecord(value)
    && isPosition(value.start)
    && isPosition(value.end);
}

function isLocation(value: unknown): boolean {
  return isRecord(value)
    && typeof value.uri === 'string'
    && isRange(value.range);
}

function isCacheFingerprint(value: unknown): value is CacheFingerprint {
  return isRecord(value)
    && typeof value.grammarVersion === 'string'
    && typeof value.settingsHash === 'string'
    && typeof value.macroTableHash === 'string';
}

function isFunctionParameter(value: unknown): value is FunctionParameter {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.type === 'string'
    && isRange(value.range);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalRange(value: unknown): boolean {
  return value === undefined || isRange(value);
}

function isSymbolEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.name !== 'string'
    || typeof value.kind !== 'string'
    || !symbolKinds.has(value.kind as SymbolKind)
    || !isLocation(value.location)
    || !optionalString(value.scope)
    || !optionalString(value.parentType)
    || !optionalString(value.declaredType)
    || !optionalRange(value.scopeRange)
  ) {
    return false;
  }

  if (value.kind !== 'function') return true;
  return typeof value.returnType === 'string'
    && Array.isArray(value.parameters)
    && value.parameters.every(isFunctionParameter);
}

function isReferenceEntry(value: unknown): boolean {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.context === 'string'
    && referenceContexts.has(value.context as ReferenceContext)
    && isLocation(value.location)
    && optionalString(value.receiver);
}

function isShaderLabStructureNode(value: unknown): boolean {
  return isRecord(value)
    && (value.kind === 'shader' || value.kind === 'subshader' || value.kind === 'pass')
    && optionalString(value.name)
    && isFiniteNumber(value.headerLine)
    && isFiniteNumber(value.closeLine)
    && Array.isArray(value.children)
    && value.children.every(isShaderLabStructureNode);
}

function isStructureResult(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.shaders)
    && value.shaders.every(isShaderLabStructureNode);
}

function isFileIndex(value: unknown): value is FileIndex {
  return isRecord(value)
    && typeof value.uri === 'string'
    && Array.isArray(value.symbols)
    && value.symbols.every(isSymbolEntry)
    && Array.isArray(value.references)
    && value.references.every(isReferenceEntry)
    && (value.structure === undefined || isStructureResult(value.structure));
}

function isCachedFile(value: unknown): value is CachedFile {
  return isRecord(value)
    && typeof value.uri === 'string'
    && isFiniteNumber(value.mtimeMs)
    && isFiniteNumber(value.size)
    && isFileIndex(value.index);
}

function toCacheManifest(value: unknown): CacheManifest | null {
  if (
    !isRecord(value)
    || value.version !== CACHE_VERSION
    || typeof value.workspaceFolderUri !== 'string'
    || !(typeof value.unityProjectRoot === 'string' || value.unityProjectRoot === null)
    || !isFiniteNumber(value.createdAt)
    || !isCacheFingerprint(value.fingerprint)
    || !Array.isArray(value.files)
  ) {
    return null;
  }

  return {
    version: value.version,
    workspaceFolderUri: value.workspaceFolderUri,
    unityProjectRoot: value.unityProjectRoot,
    createdAt: value.createdAt,
    fingerprint: value.fingerprint,
    // CacheStore owns persisted JSON hygiene; malformed file records are skipped
    // before Workspace restore can poison indexes or throw on bad shapes.
    files: value.files.filter(isCachedFile),
  };
}

export class CacheStore {
  private static readonly saveQueues = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, 'index.json');
  }

  async load(expectedFingerprint?: CacheFingerprint): Promise<CacheManifest | null> {
    let content: string;
    try {
      content = await fs.readFile(this.path, 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    const manifest = toCacheManifest(parsed);
    if (!manifest) return null;
    if (expectedFingerprint && !fingerprintsEqual(manifest.fingerprint, expectedFingerprint)) {
      return null;
    }

    return manifest;
  }

  async save(manifest: CacheManifest): Promise<void> {
    const previous = CacheStore.saveQueues.get(this.path) ?? Promise.resolve();
    const current = previous.then(
      () => this.writeManifest(manifest),
      () => this.writeManifest(manifest),
    );
    CacheStore.saveQueues.set(this.path, current);
    try {
      await current;
    } finally {
      if (CacheStore.saveQueues.get(this.path) === current) {
        CacheStore.saveQueues.delete(this.path);
      }
    }
  }

  private async writeManifest(manifest: CacheManifest): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(manifest), 'utf8');
    await fs.rm(this.path, { force: true });
    await fs.rename(tmpPath, this.path);
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.path);
    } catch {
      // Missing cache files are already clear.
    }
  }
}
