import type { StructureResult, ShaderLabStructureNode, ShaderLabNodeKind } from '@unity-shader-nav/shared';
import { sanitizeLine } from './sanitize';

const SHADER_RE   = /^\s*Shader\s+"([^"]*)"/;
const SUBSHADER_RE = /^\s*SubShader\b/;
const PASS_RE      = /^\s*Pass\b/;
const PASS_NAME_RE = /^\s*Name\s+"([^"]*)"/;
const INLINE_NAME_RE = /\bName\s+"([^"]*)"/;

interface Frame {
  node: ShaderLabStructureNode;
  braceDepth: number;
}

export function scanStructure(text: string): StructureResult {
  const lines = text.split(/\r?\n/);
  const shaders: ShaderLabStructureNode[] = [];
  const stack: Frame[] = [];

  function open(kind: ShaderLabNodeKind, line: number, name: string | undefined): void {
    const node: ShaderLabStructureNode = {
      kind, name, headerLine: line, closeLine: line, children: [],
    };
    if (stack.length === 0) {
      if (kind === 'shader') shaders.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, braceDepth: 0 });
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = sanitizeLine(lines[i]);

    const shaderMatch = SHADER_RE.exec(raw);
    if (shaderMatch && stack.length === 0) {
      open('shader', i, shaderMatch[1]);
    } else if (SUBSHADER_RE.test(raw) && stack.length > 0 && stack[stack.length - 1].node.kind === 'shader') {
      open('subshader', i, undefined);
    } else if (PASS_RE.test(raw) && stack.length > 0 && stack[stack.length - 1].node.kind === 'subshader') {
      open('pass', i, undefined);
      // Compact form `Pass { Name "X" }` puts the name on the same line as
      // the Pass header; capture it now or PASS_NAME_RE (line-start only)
      // would miss it.
      const inlineName = INLINE_NAME_RE.exec(raw);
      if (inlineName) {
        stack[stack.length - 1].node.name = inlineName[1];
      }
    } else {
      const nameMatch = PASS_NAME_RE.exec(raw);
      if (nameMatch && stack.length > 0 && stack[stack.length - 1].node.kind === 'pass') {
        stack[stack.length - 1].node.name = nameMatch[1];
      }
    }

    for (const ch of raw) {
      if (ch === '{') {
        if (stack.length > 0) stack[stack.length - 1].braceDepth++;
      } else if (ch === '}') {
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          top.braceDepth--;
          if (top.braceDepth <= 0) {
            top.node.closeLine = i;
            stack.pop();
          }
        }
      }
    }
  }

  return { shaders };
}
