import type {
  FileIndex,
  MaterialPropertyCompatibility,
  MaterialPropertyValueType,
  MaterialReferenceLocation,
  Position,
  ShaderLabPropertyEntry,
  ShaderLabPropertyType,
} from '@unity-shader-nav/shared';
import type { CancellationToken } from 'vscode-languageserver/node';
import type { MaterialUsageProvider } from '../adapter/materialSource';
import { throwIfRequestCancelled } from '../lifecycle/requestCancellation';
import { containsPosition } from '../sourceLocation';

export interface MaterialPropertyTarget {
  readonly shaderName: string;
  readonly property: ShaderLabPropertyEntry;
}

const ZERO_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
} as const;

export function materialPropertyTargetAt(
  index: FileIndex | undefined,
  position: Position,
): MaterialPropertyTarget | undefined {
  if (!index) return undefined;
  const directProperty = index.properties?.find((entry) => (
    containsPosition(entry.nameRange, position)
  ));
  const declarations = directProperty ? [] : index.symbols.filter((symbol) => (
    (symbol.kind === 'variable' || symbol.kind === 'cbuffer')
    && !symbol.scopeRange
    && !symbol.parentType
    && containsPosition(symbol.location.range, position)
  ));
  const matchingProperties = declarations.length === 1
    ? (index.properties ?? []).filter((entry) => entry.name === declarations[0].name)
    : [];
  const property = directProperty
    ?? (matchingProperties.length === 1 ? matchingProperties[0] : undefined);
  if (!property) return undefined;

  const shader = index.structure?.shaders.find((entry) => (
    entry.headerLine <= property.nameRange.start.line
    && property.nameRange.start.line <= entry.closeLine
  ));
  const shaderName = shader?.name;
  return shaderName ? { shaderName, property } : undefined;
}

function unityAssetPath(uri: string): string {
  try {
    // Use the URL API (platform-independent) rather than fileURLToPath so
    // that drive-letter-less URIs (e.g. test fixtures) resolve correctly on
    // Windows. fileURLToPath throws ERR_INVALID_FILE_URL_PATH for those.
    const { pathname } = new URL(uri);
    const match = /(?:^|\/)((?:Assets|Packages)\/.*)$/.exec(pathname);
    return match?.[1] ?? pathname;
  } catch {
    return uri;
  }
}

function materialUri(assetPath: string, shaderUri: string): string | undefined {
  const normalizedAssetPath = assetPath.replace(/\\/g, '/');
  if (!/^(?:Assets|Packages)\//.test(normalizedAssetPath)) return undefined;

  try {
    // Extract the project root from the shader URI's path component and
    // re-join with the asset path using forward slashes. This avoids
    // fileURLToPath/pathToFileURL which require a drive letter on Windows.
    const { pathname } = new URL(shaderUri);
    const marker = /\/(?:Assets|Packages)\//.exec(pathname);
    if (!marker) return undefined;
    const projectRoot = pathname.slice(0, marker.index);
    const resolved = `${projectRoot}/${normalizedAssetPath}`.replace(/\/+/g, '/');
    return new URL(`file://${resolved}`).href;
  } catch {
    return undefined;
  }
}

function expectedValueType(
  shaderType: ShaderLabPropertyType,
): MaterialPropertyValueType {
  switch (shaderType) {
    case '2D':
    case '2DArray':
    case '3D':
    case 'Cube':
    case 'CubeArray':
      return 'texture';
    case 'Color':
    case 'Vector':
      // Unity serializes both in the vector/color value bucket.
      return 'vector';
    case 'Float':
    case 'Range':
    case 'Int':
      // Legacy ShaderLab Int values are float-backed in serialized Materials.
      return 'float';
    case 'Integer':
      return 'integer';
  }
}

export function materialPropertyCompatibility(
  shaderType: ShaderLabPropertyType | null,
  serializedType: MaterialPropertyValueType,
): MaterialPropertyCompatibility {
  if (!shaderType) return 'unknown';
  return expectedValueType(shaderType) === serializedType
    ? 'compatible'
    : 'type-mismatch';
}

export async function materialPropertyReferences(
  documentUri: string,
  target: MaterialPropertyTarget,
  provider: MaterialUsageProvider,
  cancellation?: CancellationToken,
): Promise<MaterialReferenceLocation[]> {
  throwIfRequestCancelled(cancellation);
  const usage = await provider.materialsUsingShader({
    name: target.shaderName,
    path: unityAssetPath(documentUri),
  });
  throwIfRequestCancelled(cancellation);
  if (usage.availability === 'unknown') return [];

  const locations: MaterialReferenceLocation[] = [];
  const materials = [...usage.materials].sort((left, right) => (
    left.guid.localeCompare(right.guid) || left.path.localeCompare(right.path)
  ));
  for (const material of materials) {
    const property = material.properties.find((entry) => (
      entry.name === target.property.name
    )) ?? null;
    const uri = materialUri(material.path, documentUri);
    if (!uri) continue;
    locations.push({
      uri,
      range: ZERO_RANGE,
      data: {
        kind: 'material-property',
        asset: { guid: material.guid, path: material.path },
        property,
        shaderPropertyType: target.property.type,
        compatibility: property
          ? materialPropertyCompatibility(target.property.type, property.type)
          : 'not-serialized',
        completeness: {
          assetScope: usage.assetScope,
          runtimeMaterials: usage.runtimeMaterials,
        },
        provenance: material.provenance,
      },
    });
  }
  return locations;
}
