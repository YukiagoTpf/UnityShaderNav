import type { StructureResult, ShaderLabStructureNode, ShaderLabNodeKind } from '@unity-shader-nav/shared';

const SHADER_RE   = /^\s*Shader\s+"([^"]*)"/;
const SUBSHADER_RE = /^\s*SubShader\b/;
const PASS_RE      = /^\s*Pass\b/;
const PASS_NAME_RE = /^\s*Name\s+"([^"]*)"/;

function stripComment(line: string): string {
  return line.replace(/\/\/.*$/, '');
}

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
    const raw = stripComment(lines[i]);

    const shaderMatch = SHADER_RE.exec(raw);
    if (shaderMatch && stack.length === 0) {
      open('shader', i, shaderMatch[1]);
    } else if (SUBSHADER_RE.test(raw) && stack.length > 0 && stack[stack.length - 1].node.kind === 'shader') {
      open('subshader', i, undefined);
    } else if (PASS_RE.test(raw) && stack.length > 0 && stack[stack.length - 1].node.kind === 'subshader') {
      open('pass', i, undefined);
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
