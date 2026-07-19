import type { Position, Range, SymbolEntry } from '@unity-shader-nav/shared';
import type { DocumentLexicalToken } from '../analysis';
import type { CursorContext, CursorSource } from '../parser/lexical/cursor';
import type { PackageContext } from '../packages';
import type { UnityProjectFacts } from '../project';
import { uriKey } from '../uriKey';
import { findBuiltinEntries, type BuiltinEntry } from '../vocabulary';
import {
  documentationTargetAt,
  type DocumentationTarget,
} from './target';

export interface PackageProvenance {
  readonly name: string;
  readonly version: string | undefined;
  readonly source: string | undefined;
}

export interface DocumentationResolutionRequest {
  readonly text: string;
  readonly source?: CursorSource;
  readonly cursor?: CursorContext;
  readonly position: Position;
  readonly languageId: string;
  readonly uri: string;
  readonly lexicalTokens: readonly DocumentLexicalToken[] | undefined;
  /** Declarations already selected by the revision's index-owned scope policy. */
  readonly declarations: readonly SymbolEntry[];
  readonly visibleUriKeys: ReadonlySet<string>;
}

export type ResolvedDocumentationCandidate =
  | {
    readonly source: 'project';
    readonly symbol: SymbolEntry;
    readonly package: PackageProvenance | undefined;
  }
  | {
    readonly source: 'builtin';
    readonly entry: BuiltinEntry;
    readonly package: PackageProvenance | undefined;
    readonly verificationNote?: string;
  };

export interface DocumentationResolution {
  readonly range: Range;
  readonly candidates: readonly ResolvedDocumentationCandidate[];
}

/**
 * Revision-owned Quick Documentation policy. Callers provide captured index
 * selections and visibility; this Module owns target interpretation,
 * declaration precedence, provenance, and curated fallback compatibility.
 */
export class DocumentationResolver {
  constructor(
    private readonly packages: PackageContext,
    private readonly project: UnityProjectFacts,
  ) {}

  resolve(request: DocumentationResolutionRequest): DocumentationResolution | undefined {
    const target = documentationTargetAt(
      request.source ?? request.text,
      request.position,
      request.languageId,
      request.uri,
      request.lexicalTokens,
      request.cursor,
    );
    if (!target) return undefined;

    const declarations = this.resolveDeclarations(
      target,
      request.declarations,
      request.visibleUriKeys,
    );
    const projectPredefined = this.resolveProjectPredefined(target);
    const candidates = declarations.length > 0
      ? declarations
      : projectPredefined.length > 0
        ? projectPredefined
        : this.resolveCurated(target, request.visibleUriKeys);
    return candidates.length > 0
      ? { range: target.range, candidates }
      : undefined;
  }

  private resolveProjectPredefined(
    target: DocumentationTarget,
  ): ResolvedDocumentationCandidate[] {
    if (target.role !== 'hlslIdentifier') return [];
    const macro = this.project.predefinedShaderMacro(target.name);
    if (!macro) return [];
    const precision = macro.precision === 'documented'
      ? `Derived from project Editor ${macro.editorVersion} using Unity's documented encoding.`
      : `Derived from project Editor ${macro.editorVersion} as a major/minor prefix because Unity's documented exact encodings do not represent this full version shape.`;
    return [{
      source: 'builtin',
      entry: {
        name: macro.name,
        kind: 'macro',
        category: 'unitycg',
        detail: `#define ${macro.name} ${macro.value}`,
        documentation: `${precision} [Unity version macro convention](${UNITY_VERSION_MANUAL_URL}). This hover is presentation-only; preprocessor evaluation remains conservative.`,
      },
      package: undefined,
    }];
  }

  private resolveDeclarations(
    target: DocumentationTarget,
    declarations: readonly SymbolEntry[],
    visibleUriKeys: ReadonlySet<string>,
  ): ResolvedDocumentationCandidate[] {
    if (target.role !== 'semantic' && target.role !== 'hlslIdentifier') return [];

    const resolved: ResolvedDocumentationCandidate[] = [];
    for (const symbol of declarations) {
      if (symbol.name !== target.name) continue;
      const packageIdentity = this.packages.packageForUri(symbol.location.uri);
      if (packageIdentity && !visibleUriKeys.has(uriKey(symbol.location.uri))) continue;
      const pkg = packageIdentity
        ? this.packages.package(packageIdentity.name)
        : undefined;
      resolved.push({
        source: 'project',
        symbol,
        package: packageIdentity
          ? {
            name: packageIdentity.name,
            version: packageIdentity.version,
            source: pkg?.source,
          }
          : undefined,
      });
    }
    return resolved;
  }

  private resolveCurated(
    target: DocumentationTarget,
    visibleUriKeys: ReadonlySet<string>,
  ): ResolvedDocumentationCandidate[] {
    const resolved: ResolvedDocumentationCandidate[] = [];
    for (const entry of entriesForDocumentationTarget(target)) {
      const scope = entry.quickDocumentation?.scope;
      if (scope?.kind === 'unity') {
        const editorVersion = this.project.majorMinor();
        const verified = editorVersion !== undefined
          && scope.supportedEditorVersions.includes(editorVersion);
        resolved.push({
          source: 'builtin',
          entry,
          package: undefined,
          ...(verified
            ? {}
            : { verificationNote: unityVerificationNote(scope.supportedEditorVersions, editorVersion) }),
        });
        continue;
      }
      if (scope?.kind !== 'package') {
        resolved.push({ source: 'builtin', entry, package: undefined });
        continue;
      }

      const pkg = this.packages.package(scope.packageName);
      if (!pkg || !pkg.official) continue;
      if (!pkg.version || !scope.supportedMajorVersions.includes(majorOf(pkg.version))) continue;
      if (!this.packageIsVisible(scope.packageName, visibleUriKeys)) continue;
      resolved.push({
        source: 'builtin',
        entry,
        package: { name: pkg.name, version: pkg.version, source: pkg.source },
      });
    }
    return resolved;
  }

  private packageIsVisible(
    packageName: string,
    visibleUriKeys: ReadonlySet<string>,
  ): boolean {
    for (const uri of visibleUriKeys) {
      if (this.packages.packageForUri(uri)?.name === packageName) return true;
    }
    return false;
  }
}

const UNITY_VERSION_MANUAL_URL =
  'https://docs.unity3d.com/6000.0/Documentation/Manual/shader-branching-unity-version.html';

function entriesForDocumentationTarget(target: DocumentationTarget): readonly BuiltinEntry[] {
  return findBuiltinEntries(target.name).filter((entry) => {
    switch (target.role) {
      case 'shaderLabTerm':
        return entry.quickDocumentation !== undefined
          && (entry.roles?.includes('shaderLabKeyword') === true
            || entry.roles?.includes('shaderLabRenderState') === true);
      case 'renderStateValue':
        return entry.quickDocumentation !== undefined
          && entry.roles?.includes('shaderLabStateValue') === true;
      case 'propertyAttribute':
        return entry.quickDocumentation !== undefined
          && entry.roles?.includes('shaderLabPropertyAttribute') === true;
      case 'propertyType':
        return entry.quickDocumentation !== undefined
          && entry.roles?.includes('shaderLabPropertyType') === true;
      case 'semantic':
        return entry.category === 'semantic';
      case 'hlslIdentifier':
        return entry.category !== 'shaderlab' && entry.category !== 'semantic';
    }
  });
}

function majorOf(version: string): number {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : Number.NaN;
}

function unityVerificationNote(
  verifiedVersions: readonly string[],
  projectVersion: string | undefined,
): string {
  const verified = verifiedVersions.map((version) => `Unity ${version}`).join(', ');
  return projectVersion
    ? `Documentation verified against ${verified}; current project editor is Unity ${projectVersion}.`
    : `Documentation verified against ${verified}; current project editor version is unknown.`;
}
