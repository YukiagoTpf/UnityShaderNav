import type { Range, ShaderLabPropertyType } from './symbols';
import type { AdapterEvidenceProvenance } from './materials';

/** Adapter capability that supplies proven C# shader-property call sites. */
export const CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE = 'csharp-property-usages';

/**
 * What the Adapter can prove about the C# expression that names a property.
 *
 * - `constant-string`: a string literal, e.g. "_MainTex". Proves the name.
 *   This covers both direct literals (`material.SetColor("_MainTex", c)`)
 *   and the string argument to Shader.PropertyToID("_MainTex"), whose int
 *   result is runtime-unstable but whose name origin is a provable constant.
 * - `constant-concat`: compile-time-resolvable concatenation of constants,
 *   e.g. "_" + "MainTex". Proves the name.
 * - `dynamic`: a value the Adapter cannot resolve to a constant. Not navigable.
 */
export type CSharpExpressionDeterminism =
  | 'constant-string'
  | 'constant-concat'
  | 'dynamic';

/**
 * What the Adapter can prove about which Shader/Property a call site targets.
 *
 * - `proven`: the Adapter resolved the receiver (Material /
 *   MaterialPropertyBlock) and the owning Shader, or the call carries an
 *   explicit shader identity. Authoritative.
 * - `name-only`: the Adapter proved the property name (constant string or
 *   concat) but cannot bind it to a specific Shader. Not authoritative.
 * - `unbound`: the Adapter cannot prove either the name or the target.
 */
export type CSharpBindingDeterminism = 'proven' | 'name-only' | 'unbound';

/**
 * The kind of C# call that references a shader property.
 *
 * Note: Shader.Find is evidence of Shader identity / data flow, not a property
 * reference; keyword setters belong to the keyword domain. Neither appears in
 * property usages or final References.
 */
export type CSharpPropertyCallKind =
  | 'property-to-id'
  | 'material-set'
  | 'material-get'
  | 'material-property-block-set'
  | 'material-property-block-get';

/** Identity of the Shader a proven call site is bound to. */
export interface CSharpShaderIdentity {
  /** Shader name as declared in ShaderLab, e.g. "Tests/Lit". */
  readonly name: string;
  /** Project-relative asset path, e.g. "Assets/Shaders/Lit.shader". */
  readonly path: string;
}

/**
 * Per-usage source revision provenance. The Adapter trust boundary validates
 * the exact C# source revision (URI + content hash) before a usage can become
 * authoritative; a single opaque snapshot revision is insufficient to rule out
 * stale C# positions.
 */
export interface CSharpSourceRevision {
  /** URI of the C# source file. */
  readonly uri: string;
  /** SHA-256 of the C# source contents observed by the Adapter. */
  readonly contentHash: string;
}

/**
 * A single C# call site referencing a shader property, as reported by the
 * Adapter. This is the raw payload: it may carry name-only, dynamic, or
 * generated-id items that are explicitly rejected from authoritative results.
 * Only items with `bindingDeterminism === 'proven'` AND a provable expression
 * name (constant-string or constant-concat) AND a validated source revision
 * become authoritative references.
 */
export interface CSharpPropertyUsage {
  /** URI of the C# source file. */
  readonly uri: string;
  /** Location of the property-name token (or generated-id expression) in the C# file. */
  readonly range: Range;
  /** The property name as written, e.g. "_MainTex". Empty when determinism is `dynamic`. */
  readonly propertyName: string;
  /** ShaderLab property type when the Adapter can prove it; null otherwise. */
  readonly propertyType: ShaderLabPropertyType | null;
  readonly callKind: CSharpPropertyCallKind;
  /** Receiver type when the Adapter can prove it (Material, MaterialPropertyBlock, ...). */
  readonly receiverType: string | null;
  readonly expressionDeterminism: CSharpExpressionDeterminism;
  readonly bindingDeterminism: CSharpBindingDeterminism;
  /** Present only when `bindingDeterminism` is `proven`. */
  readonly shader: CSharpShaderIdentity | null;
  /** Exact C# source revision the Adapter observed. Required for stale-position rejection. */
  readonly sourceRevision: CSharpSourceRevision;
  readonly provenance: AdapterEvidenceProvenance<
    typeof CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE
  >;
}

/**
 * Metadata retained on an authoritative LSP Location for a proven C# property
 * call site. Only binding-proven, expression-name-provable, source-revision-
 * validated items become authoritative references; the type carries no fields
 * that imply unproven items are trusted.
 */
export interface CSharpPropertyReferenceData {
  readonly kind: 'csharp-property-usage';
  readonly propertyName: string;
  readonly propertyType: ShaderLabPropertyType | null;
  readonly callKind: CSharpPropertyCallKind;
  readonly receiverType: string | null;
  /** Always `proven` for an authoritative reference. */
  readonly bindingDeterminism: 'proven';
  /** Always a provable value for an authoritative reference. */
  readonly expressionDeterminism: 'constant-string' | 'constant-concat';
  readonly shader: CSharpShaderIdentity;
  readonly sourceRevision: CSharpSourceRevision;
  readonly provenance: CSharpPropertyUsage['provenance'];
}

/** Location-compatible authoritative result with Adapter evidence. */
export interface CSharpPropertyReferenceLocation {
  readonly uri: string;
  readonly range: Range;
  readonly data: CSharpPropertyReferenceData;
}
