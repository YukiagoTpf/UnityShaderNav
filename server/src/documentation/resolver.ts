import type { SymbolEntry } from '@unity-shader-nav/shared';
import type { PackageContext } from '../packages';
import type { UnityProjectFacts } from '../project';
import type { BuiltinEntry } from '../vocabulary';

export interface PackageProvenance {
  readonly name: string;
  readonly version: string | undefined;
  readonly source: string | undefined;
}

export interface ResolvedCuratedEntry {
  readonly entry: BuiltinEntry;
  readonly package: PackageProvenance | undefined;
}

export class DocumentationResolver {
  constructor(
    private readonly packages: PackageContext,
    private readonly project: UnityProjectFacts,
  ) {}

  projectProvenance(symbol: SymbolEntry): PackageProvenance | undefined {
    const resolved = this.packages.packageForUri(symbol.location.uri);
    if (!resolved) return undefined;
    const identity = this.packages.package(resolved.name);
    return {
      name: resolved.name,
      version: resolved.version,
      source: identity?.source,
    };
  }

  curated(
    entries: readonly BuiltinEntry[],
    visibleUriKeys: ReadonlySet<string>,
  ): ResolvedCuratedEntry[] {
    const resolved: ResolvedCuratedEntry[] = [];
    for (const entry of entries) {
      const scope = entry.quickDocumentation?.scope;
      if (
        scope === undefined
        && (entry.category === 'srp-core' || entry.category === 'urp' || entry.category === 'hdrp')
      ) continue;
      if (scope?.kind === 'unity') {
        if (!scope.supportedEditorVersions.includes(this.project.majorMinor() ?? '')) continue;
        resolved.push({ entry, package: undefined });
        continue;
      }
      if (scope?.kind !== 'package') {
        resolved.push({ entry, package: undefined });
        continue;
      }

      const pkg = this.packages.package(scope.packageName);
      if (!pkg || !pkg.official) continue;
      if (!pkg.version || !scope.supportedMajorVersions.includes(majorOf(pkg.version))) continue;
      const visible = [...visibleUriKeys].some((uri) => (
        this.packages.packageForUri(uri)?.name === scope.packageName
      ));
      if (!visible) continue;
      resolved.push({
        entry,
        package: { name: pkg.name, version: pkg.version, source: pkg.source },
      });
    }
    return resolved;
  }
}

function majorOf(version: string): number {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : Number.NaN;
}
