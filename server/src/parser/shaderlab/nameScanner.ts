import type {
  Range,
  ShaderLabBlock,
  ShaderLabNameFacts,
  ShaderLabStructureNode,
  StructureResult,
} from '@unity-shader-nav/shared';
import {
  interpretShaderLabSource,
  type ShaderLabSourceInterpretation,
} from './sourceInterpretation';

const SHADER_RE = /^\s*Shader\s+"([^"]*)"/;
const FALLBACK_RE = /^\s*Fallback\s+"([^"]*)"/;
const USE_PASS_RE = /^\s*UsePass\s+"([^"]*)"/;
const PASS_NAME_RE = /\bName\s+"([^"]*)"/g;

function range(line: number, start: number, end: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

function valueRange(line: number, source: string, fullMatch: string, value: string): Range {
  const matchStart = source.indexOf(fullMatch);
  const quoteStart = source.indexOf('"', matchStart);
  return range(line, quoteStart + 1, quoteStart + 1 + value.length);
}

function containingShader(
  structure: StructureResult,
  line: number,
): ShaderLabStructureNode | undefined {
  return structure.shaders.find((shader) => (
    shader.headerLine <= line && line <= shader.closeLine
  ));
}

function containingPass(
  shader: ShaderLabStructureNode,
  line: number,
): ShaderLabStructureNode | undefined {
  for (const subshader of shader.children) {
    if (subshader.kind !== 'subshader') continue;
    for (const pass of subshader.children) {
      if (pass.kind !== 'pass') continue;
      if (pass.headerLine <= line && line <= pass.closeLine) return pass;
    }
  }
  return undefined;
}

function lineIsInHlslBlock(blocks: readonly ShaderLabBlock[], line: number): boolean {
  return blocks.some((block) => block.startLine <= line && line <= block.endLine);
}

export function scanShaderLabNames(
  text: string,
  blocks: readonly ShaderLabBlock[],
  structure: StructureResult,
): ShaderLabNameFacts {
  return scanShaderLabNamesFromSource(
    interpretShaderLabSource(text),
    blocks,
    structure,
  );
}

export function scanShaderLabNamesFromSource(
  source: ShaderLabSourceInterpretation,
  blocks: readonly ShaderLabBlock[],
  structure: StructureResult,
): ShaderLabNameFacts {
  const facts: ShaderLabNameFacts = { shaders: [], passes: [], references: [] };
  const lines = source.lines;

  for (let line = 0; line < lines.length; line++) {
    const sourceLine = lines[line];
    const code = sourceLine.code;
    if (lineIsInHlslBlock(blocks, line)) continue;

    const shader = SHADER_RE.exec(code);
    if (shader) {
      facts.shaders.push({
        name: shader[1],
        nameRange: valueRange(line, code, shader[0], shader[1]),
        declarationRange: range(line, 0, sourceLine.raw.length),
      });
    }

    const fallback = FALLBACK_RE.exec(code);
    if (fallback) {
      facts.references.push({
        kind: 'fallback',
        shaderName: fallback[1],
        shaderNameRange: valueRange(line, code, fallback[0], fallback[1]),
        directiveRange: range(line, 0, sourceLine.raw.length),
      });
    }

    const usePass = USE_PASS_RE.exec(code);
    if (usePass) {
      const path = usePass[1];
      const slash = path.lastIndexOf('/');
      if (slash > 0 && slash < path.length - 1) {
        const pathRange = valueRange(line, code, usePass[0], path);
        const shaderName = path.slice(0, slash);
        const passName = path.slice(slash + 1);
        facts.references.push({
          kind: 'usePass',
          shaderName,
          passName,
          canonicalPassName: passName.toUpperCase(),
          shaderNameRange: range(
            line,
            pathRange.start.character,
            pathRange.start.character + slash,
          ),
          passNameRange: range(
            line,
            pathRange.start.character + slash + 1,
            pathRange.end.character,
          ),
          directiveRange: range(line, 0, sourceLine.raw.length),
        });
      }
    }

    const owner = containingShader(structure, line);
    if (!owner?.name || !containingPass(owner, line)) continue;
    for (const name of code.matchAll(PASS_NAME_RE)) {
      const value = name[1];
      const fullStart = name.index ?? 0;
      const quote = code.indexOf('"', fullStart);
      facts.passes.push({
        shaderName: owner.name,
        name: value,
        canonicalName: value.toUpperCase(),
        nameRange: range(line, quote + 1, quote + 1 + value.length),
        declarationRange: range(line, 0, sourceLine.raw.length),
      });
    }
  }

  return facts;
}
