import { createHash } from 'node:crypto';
import type {
  CompileProfile,
  CompileProfileRunResult,
  PortabilityCompilerVerification,
  PortabilityFinding,
  PortabilityPackageEvidence,
  PortabilityReport,
  PortabilitySafeFix,
  PortabilityTarget,
  Range,
} from '@unity-shader-nav/shared';
import {
  SHADER_MESSAGES_CAPABILITY,
  UNIVERSAL_RENDER_PIPELINE_PACKAGE,
} from '@unity-shader-nav/shared';
import { analyzeDocument } from '../analysis';
import { uriKey } from '../uriKey';

export interface PortabilityAnalysisEnvironment {
  readonly unityVersion?: string;
  readonly renderPipelinePackages: readonly PortabilityPackageEvidence[];
}

export interface PortabilityReportInput {
  readonly uri: string;
  readonly source: string;
  readonly target: PortabilityTarget;
  readonly environment: PortabilityAnalysisEnvironment;
  readonly compilerResult?: CompileProfileRunResult;
}

interface FixableFindingInput {
  readonly id: string;
  readonly area: PortabilityFinding['area'];
  readonly title: string;
  readonly explanation: string;
  readonly edits: PortabilitySafeFix['edits'];
  readonly range?: Range;
  readonly eligible: boolean;
}

function range(line: number, start: number, end: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

function fixableFinding(input: FixableFindingInput): PortabilityFinding {
  return {
    id: input.id,
    category: 'mechanical-change',
    area: input.area,
    title: input.title,
    explanation: input.explanation,
    ...(input.range ? { range: input.range } : {}),
    ...(input.eligible ? {
      safeFix: {
        title: input.title,
        edits: input.edits,
      },
    } : {}),
  };
}

const VALIDATED_URP_VERSION_PAIRS = [
  {
    unity: /^2022\.(?:2|3)\.\d+[abfp]\d+(?:[A-Za-z0-9.-]*)?$/,
    urp: /^14\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/,
  },
  {
    unity: /^6000\.0\.\d+[abfp]\d+(?:[A-Za-z0-9.-]*)?$/,
    urp: /^17\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/,
  },
] as const;
const MATERIAL_NUMERIC_PROPERTY_TYPES = new Set([
  'Color',
  'Vector',
  'Float',
  'Range',
  'Int',
  'Integer',
]);
const SURFACE_PRAGMA_RE = /^\s*#\s*pragma\s+surface\b/;
const LEGACY_LIGHTING_RE = /(?:["<](?:AutoLight|Lighting)\.cginc[">]|\bLighting[A-Za-z0-9_]*\b|\bUnityWorldSpaceLightDir\b|\bUNITY_LIGHT_ATTENUATION\b|#\s*pragma\s+multi_compile_fwdbase\b)/;
const LEGACY_TEXTURE_RE = /\b(?:sampler(?:1D|2D|3D|CUBE)|tex(?:1D|2D|3D|CUBE)|UNITY_DECLARE_TEX|TEXTURE2D|SAMPLE_TEXTURE|TRANSFORM_TEX)\w*\b/;
const LEGACY_UNITYCG_DEPENDENCY_RE = /\b(?:appdata_(?:base|tan|full)|v2f_img|UNITY_[A-Z0-9_]+|UnityObjectTo(?:View|World)[A-Za-z0-9_]*|UnityWorldToClipPos|UnityWorldSpace(?:View|Light)Dir|ComputeScreenPos)\b/;
const SOURCE_MACRO_RE = /^\s*#\s*(?:define|undef|if|ifdef|ifndef|elif|else|endif)\b/;
const ALLOWED_URP_MIGRATION_INCLUDES = new Set([
  'UnityCG.cginc',
  'Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl',
]);
const URP_LIGHT_MODES = new Set([
  'UniversalForward',
  'UniversalGBuffer',
  'UniversalForwardOnly',
  'DepthNormalsOnly',
  'DepthOnly',
  'ShadowCaster',
  'Meta',
  'SRPDefaultUnlit',
  'Universal2D',
]);

function urpProjectIsMechanicallyValidated(
  unityVersion: string | undefined,
  pkg: PortabilityPackageEvidence | undefined,
): boolean {
  return !!unityVersion
    && pkg?.official === true
    && VALIDATED_URP_VERSION_PAIRS.some((pair) => (
      pair.unity.test(unityVersion) && pair.urp.test(pkg.version ?? '')
    ));
}

function allMatches(
  text: string,
  expression: RegExp,
): Array<{ start: number; end: number; replacement: string }> {
  const matches: Array<{ start: number; end: number; replacement: string }> = [];
  for (const match of text.matchAll(expression)) {
    if (match.index === undefined) continue;
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: match[1] ? `half${match[1]}` : 'half',
    });
  }
  return matches;
}

function sameProfile(left: CompileProfile, right: CompileProfile): boolean {
  return left.name === right.name
    && left.platform === right.platform
    && left.graphicsApi === right.graphicsApi
    && left.capability === right.capability;
}

function hasExactCompilerEvidence(
  input: PortabilityReportInput,
  result: Extract<CompileProfileRunResult, { status: 'completed' }>,
): boolean {
  if (result.diagnostics.length === 0) return false;
  const warningCount = result.diagnostics.filter((diagnostic) => (
    diagnostic.shaderMessage.severity === 'warning'
  )).length;
  const errorCount = result.diagnostics.length - warningCount;
  if (
    result.warningCount !== warningCount
    || result.errorCount !== errorCount
    || result.success !== (errorCount === 0)
  ) return false;

  const contentHash = createHash('sha256').update(input.source, 'utf8').digest('hex');
  const first = result.diagnostics[0].provenance;
  return first.projectId.trim().length > 0
    && first.instanceId.trim().length > 0
    && first.adapterVersion.trim().length > 0
    && result.diagnostics.every((diagnostic) => {
      const provenance = diagnostic.provenance;
      return sameProfile(result.profile, diagnostic.profile)
        && provenance.capability === SHADER_MESSAGES_CAPABILITY
        && provenance.projectId === first.projectId
        && provenance.instanceId === first.instanceId
        && provenance.adapterVersion === first.adapterVersion
        && provenance.unityVersion === first.unityVersion
        && Number.isFinite(provenance.collectedAt)
        && uriKey(provenance.sourceRevision.uri) === uriKey(input.uri)
        && provenance.sourceRevision.assetGuid.trim().length > 0
        && provenance.sourceRevision.contentHash === contentHash;
    });
}

function compilerVerification(
  input: PortabilityReportInput,
): PortabilityCompilerVerification {
  if (input.target.kind !== 'graphics-profile' || !input.compilerResult) {
    return { status: 'required' };
  }
  const { compilerResult, target } = input;
  const resultProfile = compilerResult.status === 'completed'
    ? compilerResult.profile
    : compilerResult.requestedProfile;
  if (!sameProfile(target.profile, resultProfile)) {
    return {
      status: 'unavailable',
      profile: target.profile,
      reason: 'invalid-evidence',
    };
  }
  if (compilerResult.status === 'profile-not-supported') {
    return {
      status: 'unavailable',
      profile: target.profile,
      reason: 'profile-not-supported',
    };
  }
  if (compilerResult.status === 'adapter-unavailable') {
    return {
      status: 'unavailable',
      profile: target.profile,
      reason: compilerResult.reason,
    };
  }
  if (!hasExactCompilerEvidence(input, compilerResult)) {
    return {
      status: 'unavailable',
      profile: target.profile,
      reason: 'invalid-evidence',
    };
  }
  const compilerUnityVersions = new Set(compilerResult.diagnostics.map((diagnostic) => (
    diagnostic.provenance.unityVersion
  )));
  if (
    compilerUnityVersions.size > 1
    || (input.environment.unityVersion !== undefined
      && [...compilerUnityVersions].some((version) => (
        version !== input.environment.unityVersion
      )))
  ) {
    return {
      status: 'unavailable',
      profile: target.profile,
      reason: 'invalid-evidence',
    };
  }
  const unityVersion = [...compilerUnityVersions][0]
    ?? input.environment.unityVersion;
  if (!unityVersion) {
    return {
      status: 'unavailable',
      profile: target.profile,
      reason: 'invalid-evidence',
    };
  }
  return {
    status: compilerResult.success ? 'passed' : 'failed',
    profile: target.profile,
    unityVersion,
    durationMs: compilerResult.durationMs,
    warningCount: compilerResult.warningCount,
    errorCount: compilerResult.errorCount,
  };
}

export function createPortabilityReport(input: PortabilityReportInput): PortabilityReport {
  const pipelinePackage = input.environment.renderPipelinePackages.find((pkg) => (
    pkg.name === UNIVERSAL_RENDER_PIPELINE_PACKAGE
  ));
  const environment = {
    ...(input.environment.unityVersion
      ? { unityVersion: input.environment.unityVersion }
      : {}),
    ...(pipelinePackage ? { renderPipelinePackage: { ...pipelinePackage } } : {}),
  };
  const report: PortabilityReport = {
    uri: input.uri,
    target: input.target,
    environment,
    equivalence: 'not-claimed',
    compilerVerification: compilerVerification(input),
    findings: [],
  };
  if (input.target.kind !== 'render-pipeline') {
    const verification = report.compilerVerification;
    if (verification.status === 'failed') {
      return {
        ...report,
        findings: [{
          id: 'graphics-profile-compile-failed',
          category: 'unsupported-semantic',
          area: 'compiler',
          title: `Shader does not compile for ${input.target.profile.name}`,
          explanation: `Unity reported ${verification.errorCount} error(s) and ${verification.warningCount} warning(s) for the exact selected graphics profile.`,
        }],
      };
    }
    if (verification.status === 'unavailable') {
      return {
        ...report,
        findings: [{
          id: 'graphics-profile-verification-unavailable',
          category: verification.reason === 'profile-not-supported'
            ? 'unsupported-semantic'
            : 'verification-requirement',
          area: 'compiler',
          title: `Compiler verification unavailable for ${input.target.profile.name}`,
          explanation: `Unity compiler evidence is unavailable (${verification.reason}); no compatibility conclusion can be drawn.`,
        }],
      };
    }
    if (verification.status === 'required') {
      return {
        ...report,
        findings: [{
          id: 'graphics-profile-verification-required',
          category: 'verification-requirement',
          area: 'compiler',
          title: `Compile with ${input.target.profile.name}`,
          explanation: 'Save the exact source and run the selected Adapter compile profile before drawing a compatibility conclusion.',
        }],
      };
    }
    return report;
  }

  const analysis = analyzeDocument(input.uri, input.source, 'full');
  if (!analysis) return report;
  const source = {
    lines: analysis.sourceLines.map((raw, line) => ({
      line,
      raw,
      code: analysis.sourceCodeLines[line] ?? '',
      codeWithoutStrings: analysis.sourceCodeWithoutStringLines[line] ?? '',
    })),
  };
  const shader = analysis.structure.shaders[0];
  const subShaders = shader?.children.filter((node) => node.kind === 'subshader') ?? [];
  const passes = subShaders.flatMap((subShader) => (
    subShader.children.filter((node) => node.kind === 'pass')
  ));
  const narrow = analysis.layout.safe
    && analysis.structure.shaders.length === 1
    && subShaders.length === 1
    && passes.length === 1
    && analysis.blocks.length === 1
    && (analysis.blocks[0].kind === 'CGPROGRAM'
      || analysis.blocks[0].kind === 'HLSLPROGRAM')
    && analysis.layout.lines[analysis.blocks[0].startLine]?.directScope === 'pass';
  const isProgramContent = (line: number): boolean => analysis.blocks.some((block) => (
    block.contentStartLine <= line && line <= block.contentEndLine
  ));
  const programLines = source.lines.filter((line) => isProgramContent(line.line));
  const shaderLabLines = source.lines.filter((line) => !isProgramContent(line.line));
  const localObjectToClipDeclaration = programLines.flatMap((line) => {
    const declaration = /^\s*(?:(?:inline|static|const)\s+)*[A-Za-z_]\w*\s+UnityObjectToClipPos\s*\(/.exec(
      line.codeWithoutStrings,
    );
    return declaration?.index === undefined
      ? []
      : [{ line: line.line, start: declaration.index, end: declaration.index + declaration[0].length }];
  })[0];
  const includePaths = programLines.flatMap((line) => {
    const include = /^\s*#\s*include\s*["<]([^">]+)[">]/.exec(line.code);
    return include ? [{ path: include[1], line: line.line, index: include.index }] : [];
  });
  const customIncludes = includePaths.filter((include) => (
    !ALLOWED_URP_MIGRATION_INCLUDES.has(include.path)
  ));
  const hasSurface = programLines.some((line) => SURFACE_PRAGMA_RE.test(line.code));
  const hasLegacyLighting = programLines.some((line) => LEGACY_LIGHTING_RE.test(line.code));
  const hasLegacyTexture = programLines.some((line) => LEGACY_TEXTURE_RE.test(line.code));
  const hasLegacyUnityCgDependency = programLines.some((line) => (
    LEGACY_UNITYCG_DEPENDENCY_RE.test(line.code)
  ));
  const hasSourceMacros = programLines.some((line) => SOURCE_MACRO_RE.test(line.code));
  const hasGrabPass = shaderLabLines.some((line) => /\bGrabPass\b/.test(line.code));
  const hasExternalPassSemantics = shaderLabLines.some((line) => (
    /\bUsePass\b/.test(line.code)
    || /\bFallback\s+(?!Off\b)/.test(line.code)
  ));
  const hasDifferentPipelineTag = shaderLabLines.some((line) => {
    const tag = /"RenderPipeline"\s*=\s*"([^"]*)"/.exec(line.code);
    return !!tag && tag[1] !== 'UniversalPipeline';
  });
  const unsupportedLightMode = shaderLabLines.flatMap((line) => {
    const tag = /"LightMode"\s*=\s*"([^"]*)"/.exec(line.code);
    return tag?.index === undefined || URP_LIGHT_MODES.has(tag[1])
      ? []
      : [{
          line: line.line,
          start: tag.index,
          end: tag.index + tag[0].length,
          value: tag[1],
        }];
  })[0];
  const semanticBlocker = hasSurface
    || hasLegacyLighting
    || hasLegacyTexture
    || hasLegacyUnityCgDependency
    || hasSourceMacros
    || hasGrabPass
    || hasExternalPassSemantics
    || hasDifferentPipelineTag
    || unsupportedLightMode !== undefined
    || customIncludes.length > 0;
  const versionValidated = urpProjectIsMechanicallyValidated(
    input.environment.unityVersion,
    pipelinePackage,
  );
  const eligible = narrow && !semanticBlocker && versionValidated;
  const findings: PortabilityFinding[] = [];

  if (!pipelinePackage) {
    findings.push({
      id: 'urp-target-unavailable',
      category: 'unsupported-semantic',
      area: 'feature',
      title: 'URP target is unavailable in the current project',
      explanation: `No resolved ${UNIVERSAL_RENDER_PIPELINE_PACKAGE} Package belongs to this Published indexed revision. Install and resolve the target Package before applying migration edits.`,
    });
  } else if (!pipelinePackage.official) {
    findings.push({
      id: 'urp-package-untrusted',
      category: 'verification-requirement',
      area: 'feature',
      title: 'Verify the non-official URP Package source',
      explanation: 'The resolved Package source is not proven to be the official Unity registry or built-in Package, so bundled migration rules are advisory only.',
    });
  } else if (!versionValidated) {
    findings.push({
      id: 'urp-version-unverified',
      category: 'verification-requirement',
      area: 'feature',
      title: 'Verify the Unity and URP Package version pair',
      explanation: 'This Unity Editor and URP Package version pair is outside the mechanically validated rule fixtures. No automatic edit is offered.',
    });
  }

  if (!narrow) {
    findings.push({
      id: 'urp-shape-verification',
      category: 'verification-requirement',
      area: 'shaderlab',
      title: 'Verify the ShaderLab ownership shape by hand',
      explanation: 'Mechanical migration requires one Shader, one SubShader, one Pass, and one complete Pass-owned program in a balanced layout. This source is outside that proof boundary.',
    });
  }

  if (passes.length > 1) {
    findings.push({
      id: 'urp-multi-pass-semantics',
      category: 'human-rewrite',
      area: 'pass-tag',
      title: 'Review multi-Pass behavior by hand',
      explanation: 'Pass selection, LightMode ownership, ordering, and shared material layout are pipeline semantics; static rewrites do not establish equivalent rendering.',
      range: range(passes[1].headerLine, 0, source.lines[passes[1].headerLine]?.raw.length ?? 0),
    });
  }

  if (customIncludes.length > 0) {
    const first = customIncludes[0];
    findings.push({
      id: 'urp-custom-include-rewrite',
      category: 'human-rewrite',
      area: 'include',
      title: 'Review custom include dependencies',
      explanation: `The include '${first.path}' may own pipeline-specific declarations or macros. Its dependency closure must be ported before local edits can be proven safe.`,
      range: range(first.line, first.index, first.index + source.lines[first.line].code.length),
    });
  }

  if (hasLegacyTexture) {
    findings.push({
      id: 'urp-texture-sampling-rewrite',
      category: 'human-rewrite',
      area: 'macro',
      title: 'Rewrite texture and sampler semantics',
      explanation: 'URP texture declarations split texture and sampler state and may require tiling/offset material fields. Static token replacement cannot infer the intended sampling contract.',
    });
  }

  if (hasLegacyUnityCgDependency) {
    findings.push({
      id: 'urp-unitycg-contract-rewrite',
      category: 'human-rewrite',
      area: 'include',
      title: 'Replace UnityCG-provided declarations explicitly',
      explanation: 'Legacy appdata types, matrices, and UnityCG macros can require new Attributes/Varyings fields or URP helpers. Replacing the include alone would not prove a compilable contract.',
    });
  }

  if (hasSourceMacros) {
    findings.push({
      id: 'urp-preprocessor-rewrite',
      category: 'human-rewrite',
      area: 'macro',
      title: 'Review conditional or generated macro semantics',
      explanation: 'Conditional and macro-generated code prevents one exact migration edit from representing every compiled branch.',
    });
  }

  if (hasGrabPass) {
    findings.push({
      id: 'urp-grab-pass-unsupported',
      category: 'unsupported-semantic',
      area: 'feature',
      title: 'GrabPass is unsupported by this URP migration slice',
      explanation: 'Recreate the scene-color dependency with an explicit URP renderer feature or supported pipeline texture.',
    });
  }

  if (hasExternalPassSemantics || hasDifferentPipelineTag) {
    findings.push({
      id: 'urp-pass-ownership-rewrite',
      category: 'human-rewrite',
      area: 'pass-tag',
      title: 'Review Pass ownership and pipeline tags',
      explanation: 'UsePass, non-Off Fallback, or another RenderPipeline owner changes which implementation Unity selects; no automatic equivalence is claimed.',
    });
  }

  if (unsupportedLightMode) {
    findings.push({
      id: 'urp-light-mode-rewrite',
      category: 'human-rewrite',
      area: 'pass-tag',
      title: `Rewrite the ${unsupportedLightMode.value} LightMode Pass`,
      explanation: 'Built-In and URP LightMode values select different renderer-owned Pass contracts; choose and implement the intended URP Pass explicitly.',
      range: range(
        unsupportedLightMode.line,
        unsupportedLightMode.start,
        unsupportedLightMode.end,
      ),
    });
  }

  if (localObjectToClipDeclaration) {
    findings.push({
      id: 'urp-shadowed-transform-helper',
      category: 'human-rewrite',
      area: 'macro',
      title: 'Resolve the locally declared transform helper',
      explanation: 'This source declares UnityObjectToClipPos locally, so token ownership cannot be transferred to the URP Core helper mechanically.',
      range: range(
        localObjectToClipDeclaration.line,
        localObjectToClipDeclaration.start,
        localObjectToClipDeclaration.end,
      ),
    });
  }

  const materialProperties = analysis.shaderLabProperties.entries.filter((property) => (
    property.type !== null && MATERIAL_NUMERIC_PROPERTY_TYPES.has(property.type)
  ));
  const materialCbuffers = analysis.shaderLabMaterial.cbuffers.filter((cbuffer) => (
    cbuffer.name === 'UnityPerMaterial'
  ));
  const incompleteMaterialProperties = materialProperties.filter((property) => (
    materialCbuffers.length === 0
    || materialCbuffers.some((cbuffer) => !cbuffer.fields.some((field) => (
      field.name === property.name
    )))
  ));
  if (incompleteMaterialProperties.length > 0) {
    findings.push({
      id: 'urp-unity-per-material-rewrite',
      category: 'human-rewrite',
      area: 'cbuffer',
      title: 'Reconcile material values in UnityPerMaterial',
      explanation: 'Every material value must use one identical UnityPerMaterial layout across applicable Passes. Use the exact SRP Batcher diagnostic when it can prove a local insertion; this report does not move declarations or infer shared include ownership.',
      range: incompleteMaterialProperties[0].nameRange,
    });
  }

  let surfaceReported = false;
  let lightingReported = false;
  for (const line of programLines) {
    if (!surfaceReported) {
      const surface = SURFACE_PRAGMA_RE.exec(line.code);
      if (surface) {
        findings.push({
          id: 'urp-surface-shader-unsupported',
          category: 'unsupported-semantic',
          area: 'feature',
          title: 'Surface Shader semantics are unsupported in URP',
          explanation: 'Surface Shader code generation exists only in the Built-In Render Pipeline. Recreate the lighting model in URP HLSL or Shader Graph.',
          range: range(line.line, surface.index, surface.index + surface[0].length),
        });
        surfaceReported = true;
      }
    }
    if (!lightingReported) {
      const lighting = LEGACY_LIGHTING_RE.exec(line.code);
      if (lighting?.index !== undefined) {
        findings.push({
          id: 'urp-lighting-rewrite',
          category: 'human-rewrite',
          area: 'feature',
          title: 'Rewrite Built-In lighting semantics',
          explanation: 'Core.hlsl intentionally does not provide Built-In lighting functions or generated lighting passes. Select and implement the intended URP lighting path explicitly.',
          range: range(line.line, lighting.index, lighting.index + lighting[0].length),
        });
        lightingReported = true;
      }
    }
  }

  const startEdits = analysis.blocks.flatMap((block) => (
    block.kind === 'CGPROGRAM'
      ? [{
          range: range(
            block.startLine,
            source.lines[block.startLine].code.indexOf('CGPROGRAM'),
            source.lines[block.startLine].code.indexOf('CGPROGRAM') + 'CGPROGRAM'.length,
          ),
          newText: 'HLSLPROGRAM',
        }]
      : []
  ));
  const endEdits = analysis.blocks.flatMap((block) => {
    if (block.kind !== 'CGPROGRAM' || block.unterminated) return [];
    const start = source.lines[block.endLine].code.indexOf('ENDCG');
    return start < 0 ? [] : [{
      range: range(block.endLine, start, start + 'ENDCG'.length),
      newText: 'ENDHLSL',
    }];
  });
  if (startEdits.length > 0 && startEdits.length === endEdits.length) {
    findings.push(fixableFinding({
      id: 'urp-program-language',
      area: 'shaderlab',
      title: 'Use an HLSLPROGRAM block for URP',
      explanation: 'URP program blocks use HLSLPROGRAM and ENDHLSL; this changes only the exact block delimiters.',
      edits: [...startEdits, ...endEdits],
      range: startEdits[0].range,
      eligible,
    }));
  }

  for (const line of programLines) {
    const include = /^\s*#\s*include\s*(["<]UnityCG\.cginc[">])/.exec(line.code);
    if (include?.index !== undefined) {
      const includeToken = include[1];
      const start = include.index + include[0].lastIndexOf(includeToken);
      findings.push(fixableFinding({
        id: `urp-core-include-${line.line}-${start}`,
        area: 'include',
        title: 'Use the URP Core.hlsl include',
        explanation: 'The selected URP package exposes core transforms through its versioned Core.hlsl path.',
        edits: [{
          range: range(line.line, start, start + includeToken.length),
          newText: '"Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
        }],
        range: range(line.line, start, start + includeToken.length),
        eligible,
      }));
    }

    if (/^\s*#/.test(line.codeWithoutStrings)) continue;

    if (!localObjectToClipDeclaration) {
      const transform = /\bUnityObjectToClipPos\b(?=\s*\()/g;
      for (const match of line.codeWithoutStrings.matchAll(transform)) {
        if (match.index === undefined) continue;
        findings.push(fixableFinding({
          id: `urp-object-to-clip-${line.line}-${match.index}`,
          area: 'macro',
          title: 'Use TransformObjectToHClip',
          explanation: 'Core.hlsl provides the URP object-to-clip transform for this exact call site.',
          edits: [{
            range: range(line.line, match.index, match.index + match[0].length),
            newText: 'TransformObjectToHClip',
          }],
          range: range(line.line, match.index, match.index + match[0].length),
          eligible,
        }));
      }
    }

    const precision = allMatches(
      line.codeWithoutStrings,
      /\bfixed([1-4](?:x[1-4])?)?\b/g,
    );
    if (precision.length > 0) {
      findings.push(fixableFinding({
        id: `urp-fixed-precision-${line.line}`,
        area: 'precision',
        title: 'Replace unsupported fixed precision with half',
        explanation: 'URP does not support fixed types; half is the documented replacement and still requires target compilation.',
        edits: precision.map((match) => ({
          range: range(line.line, match.start, match.end),
          newText: match.replacement,
        })),
        range: range(line.line, precision[0].start, precision[0].end),
        eligible,
      }));
    }
  }

  const subShader = subShaders[0];
  if (subShader) {
    let subShaderTagsFound = false;
    let renderPipelineTagFound = false;
    for (let lineNo = subShader.headerLine; lineNo <= subShader.closeLine; lineNo++) {
      const line = source.lines[lineNo];
      if (!line || analysis.layout.lines[lineNo]?.directScope !== 'subshader') continue;
      if (/"RenderPipeline"\s*=/.test(line.code)) {
        renderPipelineTagFound = true;
        break;
      }
      if (!/\bTags\b/.test(line.code)) continue;
      subShaderTagsFound = true;
      const tags = /\bTags\s*\{[^{}]*\}/.exec(line.code);
      if (tags?.index === undefined) continue;
      const close = tags.index + tags[0].lastIndexOf('}');
      let trailingWhitespaceStart = close;
      while (
        trailingWhitespaceStart > tags.index
        && /\s/.test(line.raw[trailingWhitespaceStart - 1] ?? '')
      ) trailingWhitespaceStart--;
      findings.push(fixableFinding({
        id: 'urp-render-pipeline-tag',
        area: 'pass-tag',
        title: 'Scope the SubShader to UniversalPipeline',
        explanation: 'The RenderPipeline tag deterministically selects the installed Universal Render Pipeline.',
        edits: [{
          range: range(lineNo, trailingWhitespaceStart, close),
          newText: ' "RenderPipeline" = "UniversalPipeline" ',
        }],
        range: range(lineNo, tags.index, tags.index + tags[0].length),
        eligible,
      }));
      break;
    }
    if (!renderPipelineTagFound && !subShaderTagsFound) {
      let openingLine: number | undefined;
      for (let lineNo = subShader.headerLine; lineNo <= subShader.closeLine; lineNo++) {
        if (source.lines[lineNo]?.codeWithoutStrings.includes('{')) {
          openingLine = lineNo;
          break;
        }
      }
      if (openingLine !== undefined) {
        const passIndent = /^(\s*)/.exec(
          source.lines[passes[0]?.headerLine ?? openingLine].raw,
        )?.[1] ?? '';
        const raw = source.lines[openingLine].raw;
        findings.push(fixableFinding({
          id: 'urp-render-pipeline-tag',
          area: 'pass-tag',
          title: 'Add a UniversalPipeline SubShader tag',
          explanation: 'The complete single-SubShader layout proves where a new render-pipeline ownership tag belongs.',
          edits: [{
            range: range(openingLine, raw.length, raw.length),
            newText: `${analysis.shaderLabMaterial.lineEnding}${passIndent}Tags { "RenderPipeline" = "UniversalPipeline" }`,
          }],
          range: range(
            subShader.headerLine,
            0,
            source.lines[subShader.headerLine]?.raw.length ?? 0,
          ),
          eligible,
        }));
      }
    } else if (!renderPipelineTagFound && subShaderTagsFound && !findings.some((finding) => (
      finding.id === 'urp-render-pipeline-tag'
    ))) {
      findings.push({
        id: 'urp-render-pipeline-tag-structure',
        category: 'human-rewrite',
        area: 'pass-tag',
        title: 'Add UniversalPipeline to the existing SubShader Tags block',
        explanation: 'The Tags block spans a structure this slice does not edit mechanically; preserve its formatting and ownership by hand.',
        range: range(
          subShader.headerLine,
          0,
          source.lines[subShader.headerLine]?.raw.length ?? 0,
        ),
      });
    }
  }

  findings.push({
    id: 'unity-compiler-verification',
    category: 'verification-requirement',
    area: 'compiler',
    title: 'Compile the exact saved source in Unity',
    explanation: 'Static edits do not prove rendered equivalence. Compile the pre-fix and post-fix source with a selected Adapter profile and inspect the material in Unity.',
  });

  return { ...report, findings };
}
