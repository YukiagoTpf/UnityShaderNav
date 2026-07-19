import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  FileIndex,
  IncludePointContext,
  Range,
  ShaderContextDirectiveEntry,
  ShaderContextStageEntry,
  ShaderProgramContextEntry,
} from '@unity-shader-nav/shared';
import type { IncludeChain } from '../include';
import type { PreprocessorContext } from '../parser/preproc/context';
import { uriKey } from '../uriKey';
import type { WorkspaceIndexReadView } from './workspaceIndex';

interface IncludeEdgeLocation {
  readonly uri: string;
  readonly range: Range;
}

interface MutablePreprocessorState {
  readonly definedMacros: Set<string>;
  readonly undefinedMacros: Set<string>;
  readonly variantKeywords: Set<string>;
}

export interface ResolvedIncludePointContext {
  readonly presentation: IncludePointContext;
  readonly preprocessor: PreprocessorContext;
}

/**
 * Lazily derives the bounded set of real include chains from one immutable
 * revision. Resolution promises and their failures are owned by the matching
 * IncludeChain, so no result can mix filesystem observations across revisions.
 */
export class IncludePointContextMatrix {
  private matrix: Promise<ReadonlyMap<string, readonly ResolvedIncludePointContext[]>> | undefined;

  constructor(
    private readonly index: WorkspaceIndexReadView,
    private readonly includeChain: IncludeChain,
  ) {}

  async recordsFor(uri: string): Promise<readonly ResolvedIncludePointContext[]> {
    return (await this.build()).get(uriKey(uri)) ?? [];
  }

  async recordFor(
    uri: string,
    contextId: string,
  ): Promise<ResolvedIncludePointContext | undefined> {
    return (await this.recordsFor(uri)).find(({ presentation }) => (
      presentation.id === contextId
    ));
  }

  async recordById(
    contextId: string,
  ): Promise<ResolvedIncludePointContext | undefined> {
    for (const records of (await this.build()).values()) {
      const match = records.find(({ presentation }) => presentation.id === contextId);
      if (match) return match;
    }
    return undefined;
  }

  private build(): Promise<ReadonlyMap<string, readonly ResolvedIncludePointContext[]>> {
    this.matrix ??= this.derive();
    return this.matrix;
  }

  private async derive(): Promise<ReadonlyMap<string, readonly ResolvedIncludePointContext[]>> {
    const byTarget = new Map<string, Map<string, ResolvedIncludePointContext>>();
    for (const shaderUri of this.index.store.uris()) {
      const shader = this.index.store.get(shaderUri);
      const programs = shader?.shaderContext?.programs;
      if (!shader || !programs || programs.length === 0) continue;
      for (const program of programs) {
        for (const stage of program.stages) {
          const state: MutablePreprocessorState = {
            definedMacros: new Set(stage.defines),
            undefinedMacros: new Set(),
            variantKeywords: new Set(),
          };
          const activePath = new Set([uriKey(shaderUri)]);
          for (const blockIndex of program.sharedBlockIndices) {
            await this.executeSource(
              shaderUri,
              shader,
              blockIndex,
              program,
              stage,
              state,
              [],
              activePath,
              byTarget,
            );
          }
          await this.executeSource(
            shaderUri,
            shader,
            program.blockIndex,
            program,
            stage,
            state,
            [],
            activePath,
            byTarget,
          );
        }
      }
    }

    const result = new Map<string, readonly ResolvedIncludePointContext[]>();
    for (const [target, records] of byTarget) {
      result.set(target, [...records.values()].sort(compareRecords));
    }
    return result;
  }

  private async executeSource(
    uri: string,
    index: FileIndex,
    blockIndex: number | undefined,
    program: ShaderProgramContextEntry,
    stage: ShaderContextStageEntry,
    state: MutablePreprocessorState,
    chain: readonly IncludeEdgeLocation[],
    activePath: ReadonlySet<string>,
    byTarget: Map<string, Map<string, ResolvedIncludePointContext>>,
  ): Promise<void> {
    const facts = index.shaderContext;
    if (!facts) return;
    for (const pragma of facts.variantPragmas) {
      if (
        pragma.blockIndex !== blockIndex
        || pragma.conditional
        || (pragma.stage !== undefined && pragma.stage !== stage.stage)
      ) continue;
      for (const keyword of pragma.keywords) state.variantKeywords.add(keyword);
    }

    const directives = facts.directives
      .filter((directive) => directive.blockIndex === blockIndex)
      .sort(compareDirectives);
    for (const directive of directives) {
      if (directive.kind === 'define' || directive.kind === 'undef') {
        if (!directive.conditional) applyMacroDirective(state, directive);
        continue;
      }

      const resolved = await this.includeChain.resolve(directive.name, uri);
      if (!resolved) continue;
      const targetUri = pathToFileURL(resolved.absolutePath).href;
      const edge = { uri, range: directive.range };
      const targetChain = [...chain, edge];
      const presentation = createPresentation(program, stage, targetChain);
      const record: ResolvedIncludePointContext = {
        presentation,
        preprocessor: snapshotState(state),
      };
      const targetKey = uriKey(targetUri);
      const contexts = byTarget.get(targetKey) ?? new Map();
      contexts.set(presentation.id, record);
      byTarget.set(targetKey, contexts);

      const targetIndex = this.index.store.get(targetUri);
      if (!targetIndex || activePath.has(targetKey)) continue;
      const nestedPath = new Set(activePath);
      nestedPath.add(targetKey);
      if (directive.conditional) {
        await this.executeSource(
          targetUri,
          targetIndex,
          undefined,
          program,
          stage,
          cloneState(state),
          targetChain,
          nestedPath,
          byTarget,
        );
      } else {
        await this.executeSource(
          targetUri,
          targetIndex,
          undefined,
          program,
          stage,
          state,
          targetChain,
          nestedPath,
          byTarget,
        );
      }
    }
  }
}

function applyMacroDirective(
  state: MutablePreprocessorState,
  directive: ShaderContextDirectiveEntry,
): void {
  if (directive.kind === 'define') {
    state.definedMacros.add(directive.name);
    state.undefinedMacros.delete(directive.name);
  } else if (directive.kind === 'undef') {
    state.undefinedMacros.add(directive.name);
    state.definedMacros.delete(directive.name);
  }
}

function cloneState(state: MutablePreprocessorState): MutablePreprocessorState {
  return {
    definedMacros: new Set(state.definedMacros),
    undefinedMacros: new Set(state.undefinedMacros),
    variantKeywords: new Set(state.variantKeywords),
  };
}

function snapshotState(state: MutablePreprocessorState): PreprocessorContext {
  return {
    activeKeywords: new Set(),
    definedMacros: new Set(state.definedMacros),
    undefinedMacros: new Set(state.undefinedMacros),
    variantKeywords: new Set(state.variantKeywords),
  };
}

function createPresentation(
  program: ShaderProgramContextEntry,
  stage: ShaderContextStageEntry,
  chain: readonly IncludeEdgeLocation[],
): IncludePointContext {
  const includeLocation = chain.at(-1)!;
  const identity = JSON.stringify({
    shaderName: program.shaderName,
    subShaderIndex: program.subShaderIndex,
    passIndex: program.passIndex ?? null,
    stage: stage.stage,
    entryPoint: stage.entryPoint,
    chain,
  });
  return {
    id: createHash('sha1').update(identity).digest('hex'),
    shaderName: program.shaderName,
    shaderUri: chain[0].uri,
    subShaderIndex: program.subShaderIndex,
    ...(program.passIndex !== undefined ? { passIndex: program.passIndex } : {}),
    ...(program.passName ? { passName: program.passName } : {}),
    stage: stage.stage,
    entryPoint: stage.entryPoint,
    includeLocation,
    chainDepth: chain.length,
  };
}

function compareDirectives(
  left: ShaderContextDirectiveEntry,
  right: ShaderContextDirectiveEntry,
): number {
  return left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character;
}

function compareRecords(
  left: ResolvedIncludePointContext,
  right: ResolvedIncludePointContext,
): number {
  const a = left.presentation;
  const b = right.presentation;
  return a.shaderName.localeCompare(b.shaderName)
    || a.subShaderIndex - b.subShaderIndex
    || (a.passIndex ?? -1) - (b.passIndex ?? -1)
    || a.stage.localeCompare(b.stage)
    || a.includeLocation.uri.localeCompare(b.includeLocation.uri)
    || a.includeLocation.range.start.line - b.includeLocation.range.start.line
    || a.id.localeCompare(b.id);
}
