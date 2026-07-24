import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CancellationToken } from 'vscode-languageserver/node';
import {
  PASS_EXPLANATION_QUESTION,
  PASS_EXPLANATION_SCHEMA_VERSION,
  type MaterialContextProgram,
  type MaterialContextResult,
  type PassExplanationEvidenceGraph,
  type PassExplanationMaterialContext,
  type PassExplanationEvidenceNode,
  type PassExplanationSourceNode,
  type Range,
  type SelectedMaterialContext,
  type ShaderLabStructureNode,
  type ShaderProgramContextEntry,
} from '@unity-shader-nav/shared';
import {
  analyzeDocument,
  type DocumentAnalysis,
} from '../analysis';
import { scanShaderContextSource } from '../parser/preproc/scanShaderContext';
import { sourceHash } from '../sourceHash';
import { throwIfRequestCancelled } from '../lifecycle/requestCancellation';

const MAX_PROJECTED_SHADER_SOURCE_BYTES = 4 * 1_024 * 1_024;
const MATERIAL_NODE_ID = 'current-material-context';
const SOURCE_NODE_ID = 'selected-source-pass';

export interface PassExplanationWorkspaceProjection {
  materialContextFor(uri: string): Promise<MaterialContextResult>;
  openDocumentSnapshot?(
    uri: string,
  ): { readonly text: string } | undefined;
}

export type PassExplanationSourceReader = (
  uri: string,
  cancellation?: CancellationToken,
) => Promise<string | undefined>;

export interface PassExplanationGraphProvider {
  graphFor(
    uri: string,
    cancellation?: CancellationToken,
  ): Promise<PassExplanationEvidenceGraph>;
}

export interface WorkspacePassExplanationProjectorOptions {
  readonly workspace: PassExplanationWorkspaceProjection;
  readonly readSource?: PassExplanationSourceReader;
}

/**
 * Projects a Workspace-validated Material Context plus source facts obtained
 * by deterministically parsing the exact saved/open source hash named by that
 * Context. The publicationId identifies Material freshness; it is not claimed
 * as provenance for the independently hash-gated source parse.
 *
 * The projector deliberately emits no selection-decision edge: selectedProgram
 * is an observation, not Adapter-authored causality.
 */
export class WorkspacePassExplanationProjector
implements PassExplanationGraphProvider {
  private readonly readSource: PassExplanationSourceReader;

  constructor(private readonly options: WorkspacePassExplanationProjectorOptions) {
    this.readSource = options.readSource
      ?? ((uri, cancellation) => this.currentSource(uri, cancellation));
  }

  async graphFor(
    uri: string,
    cancellation?: CancellationToken,
  ): Promise<PassExplanationEvidenceGraph> {
    throwIfRequestCancelled(cancellation);
    const material = await this.options.workspace.materialContextFor(uri);
    throwIfRequestCancelled(cancellation);
    if (material.status !== 'available') {
      return graph(uri, {
        material: {
          status: 'unavailable',
          reason: material.reason,
        },
      }, []);
    }

    const materialNode = {
      id: MATERIAL_NODE_ID,
      kind: 'material-context',
      context: projectMaterialContext(material.context),
    } as const;
    const sourceNode = await this.sourceNode(material.context, cancellation);
    return graph(
      uri,
      {
        // Publication identity invalidates the Material observation only. The
        // source citation below carries its own GUID + content-hash identity.
        material: {
          status: 'available',
          folderUri: material.folderUri,
          revision: material.revision,
          publicationId: material.publicationId,
        },
      },
      sourceNode ? [materialNode, sourceNode] : [materialNode],
    );
  }

  private async sourceNode(
    context: SelectedMaterialContext,
    cancellation?: CancellationToken,
  ): Promise<PassExplanationSourceNode | undefined> {
    throwIfRequestCancelled(cancellation);
    if (!passIdentified(context.selectedProgram)) return undefined;
    const shaderUri = context.shader.revision.uri;
    const source = await this.readSource(shaderUri, cancellation);
    throwIfRequestCancelled(cancellation);
    if (
      source === undefined
      || Buffer.byteLength(source, 'utf8') > MAX_PROJECTED_SHADER_SOURCE_BYTES
      || sourceHash(source) !== context.shader.revision.contentHash
    ) return undefined;

    const analysis = analyzeDocument(shaderUri, source, 'index');
    throwIfRequestCancelled(cancellation);
    if (!analysis?.layout.safe) return undefined;
    const located = locatePass(analysis, context);
    if (!located) return undefined;

    return {
      id: SOURCE_NODE_ID,
      kind: 'source-pass',
      source: {
        uri: shaderUri,
        sourceId: context.shader.revision.assetGuid,
        contentHash: context.shader.revision.contentHash,
      },
      program: located.program,
      range: located.range,
    };
  }

  private async currentSource(
    uri: string,
    cancellation?: CancellationToken,
  ): Promise<string | undefined> {
    throwIfRequestCancelled(cancellation);
    const snapshot = this.options.workspace.openDocumentSnapshot?.(uri);
    if (snapshot) return snapshot.text;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(fileURLToPath(uri), 'r');
      const { size } = await handle.stat();
      if (size > MAX_PROJECTED_SHADER_SOURCE_BYTES) return undefined;
      const bytes = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        throwIfRequestCancelled(cancellation);
        const read = await handle.read(bytes, offset, size - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      const growth = await handle.read(extra, 0, 1, size);
      throwIfRequestCancelled(cancellation);
      if (growth.bytesRead !== 0) return undefined;
      return bytes.subarray(0, offset).toString('utf8');
    } catch {
      throwIfRequestCancelled(cancellation);
      return undefined;
    } finally {
      await handle?.close();
    }
  }
}

function projectMaterialContext(
  context: SelectedMaterialContext,
): PassExplanationMaterialContext {
  return {
    selectionId: context.selectionId,
    material: projectMaterialAsset(context.material),
    shader: projectMaterialAsset(context.shader),
    ...(context.selectedProgram
      ? {
          selectedProgram: {
            subShaderIndex: context.selectedProgram.subShaderIndex,
            ...(context.selectedProgram.passIndex !== undefined
              ? { passIndex: context.selectedProgram.passIndex }
              : {}),
            ...(context.selectedProgram.passName !== undefined
              ? { passName: context.selectedProgram.passName }
              : {}),
          },
        }
      : {}),
    provenance: {
      capability: context.provenance.capability,
      projectId: context.provenance.projectId,
      instanceId: context.provenance.instanceId,
      adapterVersion: context.provenance.adapterVersion,
      unityVersion: context.provenance.unityVersion,
      collectedAt: context.provenance.collectedAt,
      sourceRevision: context.provenance.sourceRevision,
    },
  };
}

function projectMaterialAsset(
  asset: SelectedMaterialContext['material'],
): SelectedMaterialContext['material'] {
  return {
    name: asset.name,
    path: asset.path,
    revision: {
      uri: asset.revision.uri,
      assetGuid: asset.revision.assetGuid,
      contentHash: asset.revision.contentHash,
    },
  };
}

function graph(
  uri: string,
  projection: Readonly<Record<string, unknown>>,
  nodes: readonly PassExplanationEvidenceNode[],
): PassExplanationEvidenceGraph {
  const graphId = createHash('sha256')
    .update(JSON.stringify({
      uri,
      projection,
      nodes,
      edges: [],
    }), 'utf8')
    .digest('hex');
  return {
    schemaVersion: PASS_EXPLANATION_SCHEMA_VERSION,
    question: PASS_EXPLANATION_QUESTION,
    graphId: `pass-${graphId}`,
    nodes,
    edges: [],
  };
}

function passIdentified(
  selected: MaterialContextProgram | undefined,
): selected is MaterialContextProgram {
  return !!selected
    && Number.isInteger(selected.subShaderIndex)
    && selected.subShaderIndex >= 0
    && (
      (
        selected.passIndex !== undefined
        && Number.isInteger(selected.passIndex)
        && selected.passIndex >= 0
      )
      || (
        selected.passName !== undefined
        && selected.passName.trim().length > 0
      )
    );
}

function locatePass(
  analysis: DocumentAnalysis,
  context: SelectedMaterialContext,
): {
  readonly program: ShaderProgramContextEntry;
  readonly range: Range;
} | undefined {
  const selected = context.selectedProgram;
  if (!passIdentified(selected)) return undefined;

  const shaders = analysis.structure.shaders.filter(
    ({ name }) => name === context.shader.name,
  );
  if (shaders.length !== 1) return undefined;
  const subShaders = shaders[0].children.filter(
    ({ kind }) => kind === 'subshader',
  );
  const subShader = subShaders[selected.subShaderIndex];
  if (!subShader) return undefined;
  const passes = subShader.children.filter(({ kind }) => kind === 'pass');
  const selectedPass = exactPass(passes, selected);
  if (!selectedPass) return undefined;

  const facts = scanShaderContextSource(
    analysis,
    analysis.blocks,
    analysis.structure,
  );
  const programs = (facts.programs ?? []).filter((program) => (
    program.shaderName === context.shader.name
    && program.subShaderIndex === selected.subShaderIndex
    && program.passIndex === selectedPass.index
    && (
      selected.passName === undefined
      || program.passName === selected.passName
    )
  ));
  if (programs.length !== 1) return undefined;
  const range = exactPassRange(analysis, selectedPass.node);
  return range ? { program: programs[0], range } : undefined;
}

function exactPass(
  passes: readonly ShaderLabStructureNode[],
  selected: MaterialContextProgram,
): {
  readonly index: number;
  readonly node: ShaderLabStructureNode;
} | undefined {
  if (selected.passIndex !== undefined) {
    const node = passes[selected.passIndex];
    if (
      !node
      || (
        selected.passName !== undefined
        && node.name !== selected.passName
      )
    ) return undefined;
    return { index: selected.passIndex, node };
  }

  const matches = passes
    .map((node, index) => ({ index, node }))
    .filter(({ node }) => node.name === selected.passName);
  return matches.length === 1 ? matches[0] : undefined;
}

function exactPassRange(
  analysis: DocumentAnalysis,
  pass: ShaderLabStructureNode,
): Range | undefined {
  const header = analysis.sourceCodeWithoutStringLines[pass.headerLine] ?? '';
  const passToken = /\bPass\b/.exec(header);
  if (!passToken) return undefined;

  let opened = false;
  let depth = 0;
  for (let line = pass.headerLine; line <= pass.closeLine; line++) {
    const protectedLine = analysis.layout.lines[line]?.protected === true;
    const code = protectedLine
      ? ''
      : analysis.sourceCodeWithoutStringLines[line] ?? '';
    const start = line === pass.headerLine ? passToken.index : 0;
    for (let character = start; character < code.length; character++) {
      if (code[character] === '{') {
        opened = true;
        depth++;
      } else if (code[character] === '}' && opened) {
        depth--;
        if (depth === 0) {
          if (line !== pass.closeLine) return undefined;
          return {
            start: { line: pass.headerLine, character: passToken.index },
            end: { line, character: character + 1 },
          };
        }
      }
    }
  }
  return undefined;
}
