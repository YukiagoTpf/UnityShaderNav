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
  type TypeInferenceEntry,
} from '@unity-shader-nav/shared';
import { pathIdentity } from '../pathIdentity';
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

const shaderLabBlockKinds = new Set([
  'HLSLPROGRAM',
  'CGPROGRAM',
  'HLSLINCLUDE',
  'CGINCLUDE',
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

function isLocation(value: unknown, expectedUri?: string): boolean {
  return isRecord(value)
    && typeof value.uri === 'string'
    && (expectedUri === undefined || value.uri === expectedUri)
    && isRange(value.range);
}

function isCacheFingerprint(value: unknown): value is CacheFingerprint {
  return isRecord(value)
    && typeof value.indexImplementation === 'string'
    && /^[0-9a-f]{64}$/.test(value.indexImplementation)
    && typeof value.grammarVersion === 'string'
    && /^[0-9a-f]{64}$/.test(value.grammarVersion)
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

function isSymbolEntry(value: unknown, expectedUri: string): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.name !== 'string'
    || typeof value.kind !== 'string'
    || !symbolKinds.has(value.kind as SymbolKind)
    || !isLocation(value.location, expectedUri)
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

function isReferenceEntry(value: unknown, expectedUri: string): boolean {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.context === 'string'
    && referenceContexts.has(value.context as ReferenceContext)
    && isLocation(value.location, expectedUri)
    && optionalString(value.receiver);
}

function isTypeInferenceEntry(value: unknown): value is TypeInferenceEntry {
  return isRecord(value)
    && typeof value.receiver === 'string'
    && typeof value.callName === 'string'
    && isRange(value.assignmentRange)
    && optionalString(value.scope)
    && optionalRange(value.scopeRange);
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

function isShaderLabNameFacts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.shaders) || !Array.isArray(value.passes) || !Array.isArray(value.references)) {
    return false;
  }
  return value.shaders.every((entry) => (
    isRecord(entry)
    && typeof entry.name === 'string'
    && isRange(entry.nameRange)
    && isRange(entry.declarationRange)
  )) && value.passes.every((entry) => (
    isRecord(entry)
    && typeof entry.shaderName === 'string'
    && typeof entry.name === 'string'
    && typeof entry.canonicalName === 'string'
    && isRange(entry.nameRange)
    && isRange(entry.declarationRange)
  )) && value.references.every((entry) => (
    isRecord(entry)
    && isRange(entry.shaderNameRange)
    && isRange(entry.directiveRange)
    && typeof entry.shaderName === 'string'
    && (
      entry.kind === 'fallback'
      || (
        entry.kind === 'usePass'
        && typeof entry.passName === 'string'
        && typeof entry.canonicalPassName === 'string'
        && isRange(entry.passNameRange)
      )
    )
  ));
}

function isShaderLabMaterialFacts(value: unknown): boolean {
  if (
    !isRecord(value)
    || typeof value.srpEvidence !== 'boolean'
    || !isFiniteNumber(value.subShaderCount)
    || typeof value.hasIncludes !== 'boolean'
    || (value.lineEnding !== '\n' && value.lineEnding !== '\r\n')
  ) return false;
  if (!Array.isArray(value.cbuffers) || !Array.isArray(value.programBlocks)) return false;
  return value.cbuffers.every((entry) => (
    isRecord(entry)
    && typeof entry.name === 'string'
    && isRange(entry.nameRange)
    && isRange(entry.declarationRange)
    && Array.isArray(entry.fields)
    && entry.fields.every((field) => (
      isRecord(field)
      && typeof field.name === 'string'
      && typeof field.type === 'string'
      && optionalString(field.packOffset)
      && isRange(field.nameRange)
      && isRange(field.declarationRange)
      && typeof field.conditional === 'boolean'
    ))
    && isFiniteNumber(entry.blockIndex)
    && typeof entry.blockKind === 'string'
    && shaderLabBlockKinds.has(entry.blockKind)
    && isPosition(entry.insertionPosition)
    && typeof entry.fieldIndent === 'string'
    && typeof entry.conditional === 'boolean'
    && typeof entry.opaque === 'boolean'
    && typeof entry.complete === 'boolean'
  )) && value.programBlocks.every((entry) => (
    isRecord(entry)
    && isFiniteNumber(entry.blockIndex)
    && typeof entry.kind === 'string'
    && shaderLabBlockKinds.has(entry.kind)
    && isFiniteNumber(entry.startLine)
    && isFiniteNumber(entry.endLine)
    && isPosition(entry.insertionPosition)
    && typeof entry.indent === 'string'
    && typeof entry.unterminated === 'boolean'
  ));
}

function isFileIndex(value: unknown, expectedUri: string): value is FileIndex {
  return isRecord(value)
    && value.uri === expectedUri
    && Array.isArray(value.symbols)
    && value.symbols.every((symbol) => isSymbolEntry(symbol, expectedUri))
    && Array.isArray(value.references)
    && value.references.every((reference) => isReferenceEntry(reference, expectedUri))
    && (
      value.typeInferences === undefined
      || (
        Array.isArray(value.typeInferences)
        && value.typeInferences.every(isTypeInferenceEntry)
      )
    )
    && (value.structure === undefined || isStructureResult(value.structure))
    && (value.shaderLabNames === undefined || isShaderLabNameFacts(value.shaderLabNames))
    && (
      value.shaderLabMaterial === undefined
      || isShaderLabMaterialFacts(value.shaderLabMaterial)
    );
}

function isCachedFile(value: unknown): value is CachedFile {
  return isRecord(value)
    && typeof value.uri === 'string'
    && isFiniteNumber(value.mtimeMs)
    && isFiniteNumber(value.size)
    && isFileIndex(value.index, value.uri);
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

  /** Canonical key shared by stores targeting the same manifest on this platform. */
  get coordinationKey(): string {
    return pathIdentity(this.path);
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
    const previous = CacheStore.saveQueues.get(this.coordinationKey) ?? Promise.resolve();
    const current = previous.then(
      () => this.writeManifest(manifest),
      () => this.writeManifest(manifest),
    );
    CacheStore.saveQueues.set(this.coordinationKey, current);
    try {
      await current;
    } finally {
      if (CacheStore.saveQueues.get(this.coordinationKey) === current) {
        CacheStore.saveQueues.delete(this.coordinationKey);
      }
    }
  }

  private async writeManifest(manifest: CacheManifest): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(manifest), 'utf8');
      await fs.rename(tmpPath, this.path);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.path);
    } catch {
      // Missing cache files are already clear.
    }
  }
}
