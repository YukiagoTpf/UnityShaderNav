import {
  CodeActionKind,
  DiagnosticSeverity,
  type CodeAction,
  type CodeActionContext,
  type Diagnostic,
  type Range,
} from 'vscode-languageserver/node';
import type {
  FileIndex,
  ShaderLabMaterialCbufferEntry,
  ShaderLabPropertyEntry,
  ShaderLabPropertyType,
} from '@unity-shader-nav/shared';
import {
  DIAGNOSTIC_SOURCE,
  SRP_BATCHER_LAYOUT_CODE,
  SRP_BATCHER_PROPERTY_CODE,
  SRP_BATCHER_TYPE_CODE,
} from './diagnosticCodes';

export {
  SRP_BATCHER_LAYOUT_CODE,
  SRP_BATCHER_PROPERTY_CODE,
  SRP_BATCHER_TYPE_CODE,
} from './diagnosticCodes';

const CANONICAL_TYPES: Partial<Record<ShaderLabPropertyType, string>> = {
  Color: 'float4',
  Vector: 'float4',
  Float: 'float',
  Range: 'float',
  Int: 'float',
  Integer: 'int',
};

const COMPATIBLE_TYPES: Partial<Record<ShaderLabPropertyType, ReadonlySet<string>>> = {
  Color: new Set(['float4', 'half4', 'fixed4', 'real4']),
  Vector: new Set(['float4', 'half4', 'fixed4', 'real4']),
  Float: new Set(['float', 'half', 'fixed', 'real']),
  Range: new Set(['float', 'half', 'fixed', 'real']),
  Int: new Set(['float', 'half', 'fixed', 'real']),
  Integer: new Set(['int']),
};

function materialCbuffers(index: FileIndex): ShaderLabMaterialCbufferEntry[] {
  return (index.shaderLabMaterial?.cbuffers ?? [])
    .filter((entry) => entry.name === 'UnityPerMaterial');
}

function supportedProperty(
  property: ShaderLabPropertyEntry,
): property is ShaderLabPropertyEntry & { type: ShaderLabPropertyType } {
  return property.type !== null && CANONICAL_TYPES[property.type] !== undefined;
}

function samePosition(left: Range['start'], right: Range['start']): boolean {
  return left.line === right.line && left.character === right.character;
}

function sameRange(left: Range, right: Range): boolean {
  return samePosition(left.start, right.start) && samePosition(left.end, right.end);
}

function overlaps(left: Range, right: Range): boolean {
  const beforeOrEqual = (a: Range['start'], b: Range['start']): boolean => (
    a.line < b.line || (a.line === b.line && a.character <= b.character)
  );
  return beforeOrEqual(left.start, right.end) && beforeOrEqual(right.start, left.end);
}

function layoutSignature(cbuffer: ShaderLabMaterialCbufferEntry): string {
  return JSON.stringify(cbuffer.fields.map((field) => (
    [field.type, field.name, field.packOffset ?? null]
  )));
}

function localProgramCoverage(
  index: FileIndex,
  cbuffers: readonly ShaderLabMaterialCbufferEntry[],
): { exact: boolean; missing: boolean } {
  const facts = index.shaderLabMaterial;
  if (!facts || facts.hasIncludes) return { exact: false, missing: false };
  if (facts.programBlocks.some((block) => (
    block.kind === 'HLSLINCLUDE' || block.kind === 'CGINCLUDE'
  ))) return { exact: false, missing: false };
  const programs = facts.programBlocks.filter((block) => (
    block.kind === 'HLSLPROGRAM' || block.kind === 'CGPROGRAM'
  ));
  if (programs.length === 0 || programs.some((block) => block.unterminated)) {
    return { exact: false, missing: false };
  }
  return {
    exact: true,
    missing: programs.some((block) => (
      !cbuffers.some((cbuffer) => cbuffer.blockIndex === block.blockIndex)
    )),
  };
}

function fieldIsCompatible(
  property: ShaderLabPropertyEntry & { type: ShaderLabPropertyType },
  type: string,
): boolean {
  return COMPATIBLE_TYPES[property.type]?.has(type) === true;
}

function hasDeclarationOutsideMaterialCbuffer(
  index: FileIndex,
  property: ShaderLabPropertyEntry,
  cbuffers: readonly ShaderLabMaterialCbufferEntry[],
): boolean {
  const materialRanges = cbuffers.flatMap((cbuffer) => (
    cbuffer.fields
      .filter((field) => field.name === property.name)
      .map((field) => field.nameRange)
  ));
  return index.symbols.some((symbol) => (
    symbol.kind === 'variable'
    && symbol.name === property.name
    && !materialRanges.some((range) => sameRange(range, symbol.location.range))
  ));
}

function missingMessage(
  property: ShaderLabPropertyEntry,
  cbuffers: readonly ShaderLabMaterialCbufferEntry[],
  missingProgramBlock: boolean,
): string {
  if (missingProgramBlock) {
    return `One or more local program blocks has no UnityPerMaterial declaration for '${property.name}'; align every Pass manually.`;
  }
  if (cbuffers.length > 1) {
    return `Material property '${property.name}' is missing from one or more UnityPerMaterial layouts; update every Pass manually with the same ordered field.`;
  }
  return `Material property '${property.name}' must be declared in UnityPerMaterial for SRP Batcher compatibility.`;
}

export function srpBatcherDiagnostics(index: FileIndex): Diagnostic[] {
  const facts = index.shaderLabMaterial;
  if (!facts?.srpEvidence) return [];
  // Pipeline ownership is not yet projected per SubShader. Mixing scopes would
  // make a Built-in fallback look like an SRP Pass, so remain neutral.
  if (facts.subShaderCount > 1) return [];
  const cbuffers = materialCbuffers(index);
  const coverage = localProgramCoverage(index, cbuffers);
  // A material block may be supplied by an include. Until the include closure
  // contributes material-layout facts, absence from this file proves nothing.
  if (cbuffers.length === 0 && !coverage.exact) return [];
  const deterministic = cbuffers.filter((entry) => (
    entry.complete && !entry.conditional && !entry.opaque
  ));
  if (deterministic.length !== cbuffers.length) return [];
  const diagnostics: Diagnostic[] = [];

  for (const property of index.properties ?? []) {
    if (!supportedProperty(property)) continue;
    if (hasDeclarationOutsideMaterialCbuffer(index, property, cbuffers)) {
      diagnostics.push({
        range: property.nameRange,
        severity: DiagnosticSeverity.Warning,
        code: SRP_BATCHER_PROPERTY_CODE,
        source: DIAGNOSTIC_SOURCE,
        message: `Material property '${property.name}' is also declared outside UnityPerMaterial; keep each per-material value in the shared material cbuffer.`,
      });
      continue;
    }
    const matchingFields = cbuffers.flatMap((cbuffer) => (
      cbuffer.fields.filter((field) => field.name === property.name)
    ));
    if (coverage.missing || cbuffers.some((cbuffer) => (
      !cbuffer.fields.some((field) => field.name === property.name)
    ))) {
      diagnostics.push({
        range: property.nameRange,
        severity: DiagnosticSeverity.Warning,
        code: SRP_BATCHER_PROPERTY_CODE,
        source: DIAGNOSTIC_SOURCE,
        message: missingMessage(property, cbuffers, coverage.missing),
      });
      continue;
    }
    for (const field of matchingFields) {
      if (fieldIsCompatible(property, field.type)) continue;
      diagnostics.push({
        range: field.nameRange,
        severity: DiagnosticSeverity.Warning,
        code: SRP_BATCHER_TYPE_CODE,
        source: DIAGNOSTIC_SOURCE,
        message: `UnityPerMaterial field '${field.name}' has type '${field.type}', which is incompatible with ShaderLab ${property.type}.`,
      });
    }
  }

  if (deterministic.length > 1) {
    const baseline = layoutSignature(deterministic[0]);
    for (const cbuffer of deterministic.slice(1)) {
      if (layoutSignature(cbuffer) === baseline) continue;
      diagnostics.push({
        range: cbuffer.nameRange,
        severity: DiagnosticSeverity.Warning,
        code: SRP_BATCHER_LAYOUT_CODE,
        source: DIAGNOSTIC_SOURCE,
        message: 'Locally enumerable UnityPerMaterial declarations differ; use the same ordered field names, types, and explicit offsets in every Pass.',
      });
    }
  }
  return diagnostics;
}

function safeInsertion(
  index: FileIndex,
  property: ShaderLabPropertyEntry & { type: ShaderLabPropertyType },
): { range: Range; newText: string; title: string } | undefined {
  const facts = index.shaderLabMaterial;
  if (!facts) return undefined;
  if (facts.subShaderCount > 1) return undefined;
  // An include can contribute a same-name declaration that this file-local
  // scanner cannot see. Never emit an edit until include material facts join
  // the same published revision.
  if (facts.hasIncludes) return undefined;
  const cbuffers = materialCbuffers(index);
  if (hasDeclarationOutsideMaterialCbuffer(index, property, cbuffers)) return undefined;
  const type = CANONICAL_TYPES[property.type];
  if (!type) return undefined;

  if (cbuffers.length === 1) {
    const cbuffer = cbuffers[0];
    if (!cbuffer.complete || cbuffer.conditional || cbuffer.opaque) return undefined;
    if (cbuffer.fields.some((field) => field.packOffset !== undefined)) return undefined;
    if (cbuffer.fields.some((field) => field.name === property.name)) return undefined;
    if (facts.programBlocks.length !== 1) return undefined;
    return {
      range: { start: cbuffer.insertionPosition, end: cbuffer.insertionPosition },
      newText: `${cbuffer.fieldIndent}${type} ${property.name};${facts.lineEnding}`,
      title: `Add ${property.name} to UnityPerMaterial`,
    };
  }
  return undefined;
}

export function srpBatcherCodeActions(
  index: FileIndex,
  uri: string,
  version: number,
  range: Range,
  context: CodeActionContext,
): CodeAction[] {
  if (context.only && !context.only.some((kind) => (
    CodeActionKind.QuickFix === kind || CodeActionKind.QuickFix.startsWith(`${kind}.`)
  ))) return [];
  const relevant = context.diagnostics.filter((diagnostic) => (
    diagnostic.source === DIAGNOSTIC_SOURCE
    && diagnostic.code === SRP_BATCHER_PROPERTY_CODE
  ));
  if (relevant.length === 0) return [];
  const actions: CodeAction[] = [];
  for (const property of index.properties ?? []) {
    if (!supportedProperty(property) || !overlaps(property.nameRange, range)) continue;
    const propertyDiagnostics = relevant.filter((diagnostic) => (
      sameRange(diagnostic.range, property.nameRange)
    ));
    if (propertyDiagnostics.length === 0) continue;
    const insertion = safeInsertion(index, property);
    if (!insertion) continue;
    actions.push({
      title: insertion.title,
      kind: CodeActionKind.QuickFix,
      isPreferred: true,
      diagnostics: propertyDiagnostics,
      edit: {
        documentChanges: [{
          textDocument: { uri, version },
          edits: [{ range: insertion.range, newText: insertion.newText }],
        }],
      },
    });
  }
  return actions;
}
