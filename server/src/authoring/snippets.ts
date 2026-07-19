import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem,
} from 'vscode-languageserver/node';
import type { Position } from '@unity-shader-nav/shared';
import type { DocumentAnalysis } from '../analysis';
import { analyzeCursor, type CursorContext } from '../parser/lexical/cursor';

interface SnippetDefinition {
  readonly label: string;
  readonly detail: string;
  readonly body: (base: string, unit: string) => string;
}

const PROPERTY_SNIPPETS: readonly SnippetDefinition[] = [
  propertySnippet(
    'property-color',
    'ShaderLab Color Material property; add the matching HLSL declaration separately',
    '_${1:Color} ("${2:Color}", Color) = (${3:1}, ${4:1}, ${5:1}, ${6:1})',
  ),
  propertySnippet(
    'property-float',
    'ShaderLab Float Material property; add the matching HLSL declaration separately',
    '_${1:Value} ("${2:Value}", Float) = ${3:0.0}',
  ),
  propertySnippet(
    'property-range',
    'ShaderLab Range Material property; add the matching HLSL declaration separately',
    '_${1:Value} ("${2:Value}", Range(${3:0.0}, ${4:1.0})) = ${5:0.5}',
  ),
  propertySnippet(
    'property-vector',
    'ShaderLab Vector Material property; add the matching HLSL declaration separately',
    '_${1:Vector} ("${2:Vector}", Vector) = (${3:0}, ${4:0}, ${5:0}, ${6:0})',
  ),
  propertySnippet(
    'property-texture2d',
    'ShaderLab 2D texture Material property; add the matching HLSL resource separately',
    '_${1:Texture} ("${2:Texture}", 2D) = "${3:white}" {}',
  ),
];

const FINAL_TABSTOP = '${0}';

const PASS_SNIPPET: SnippetDefinition = {
  label: 'pass',
  detail: 'ShaderLab Pass skeleton',
  body: (base, unit) => renderAtCursor([
    'Pass',
    '{',
    `${unit}Name "${placeholder(1, 'PASS')}"`,
    `${unit}${FINAL_TABSTOP}`,
    '}',
  ], base),
};

const PROGRAM_SNIPPET: SnippetDefinition = {
  label: 'vertex-fragment-program',
  detail: 'Pipeline-neutral HLSL vertex/fragment skeleton; choose the clip-space transform explicitly',
  body: (base, unit) => renderAtCursor([
    ...vertexFragmentProgramLines(unit, 1),
    FINAL_TABSTOP,
  ], base),
};

const VF_PASS_SNIPPET: SnippetDefinition = {
  label: 'vfpass',
  detail: 'ShaderLab Pass with a pipeline-neutral HLSL vertex/fragment program',
  body: (base, unit) => renderAtCursor(
    vertexFragmentPassLines(unit, 1, 2),
    base,
  ),
};

const SURFACE_SHADER_SNIPPET: SnippetDefinition = {
  label: 'surf',
  detail: 'Complete Built-in Render Pipeline Surface Shader',
  body: (base, unit) => {
    const shaderName = placeholder(1, 'Custom/SurfaceShader');
    const surfaceFunction = placeholder(2, 'surf');
    const texture = placeholder(3, '_MainTex');
    const tint = placeholder(4, '_Color');
    return renderAtCursor([
      `Shader "${shaderName}"`,
      '{',
      `${unit}Properties`,
      `${unit}{`,
      `${unit.repeat(2)}${texture} ("Albedo", 2D) = "white" {}`,
      `${unit.repeat(2)}${tint} ("Color", Color) = (1, 1, 1, 1)`,
      `${unit}}`,
      `${unit}SubShader`,
      `${unit}{`,
      `${unit.repeat(2)}Tags { "RenderType" = "Opaque" }`,
      `${unit.repeat(2)}LOD 200`,
      '',
      `${unit.repeat(2)}CGPROGRAM`,
      `${unit.repeat(2)}#pragma surface ${surfaceFunction} Standard fullforwardshadows`,
      `${unit.repeat(2)}#pragma target 3.0`,
      '',
      `${unit.repeat(2)}sampler2D ${texture};`,
      `${unit.repeat(2)}fixed4 ${tint};`,
      '',
      `${unit.repeat(2)}struct Input`,
      `${unit.repeat(2)}{`,
      `${unit.repeat(3)}float2 uv${texture};`,
      `${unit.repeat(2)}};`,
      '',
      `${unit.repeat(2)}void ${surfaceFunction}(Input input, inout SurfaceOutputStandard output)`,
      `${unit.repeat(2)}{`,
      `${unit.repeat(3)}fixed4 color = tex2D(${texture}, input.uv${texture}) * ${tint};`,
      `${unit.repeat(3)}output.Albedo = color.rgb;`,
      `${unit.repeat(3)}output.Alpha = color.a;`,
      `${unit.repeat(2)}}`,
      `${unit.repeat(2)}ENDCG`,
      `${unit}}`,
      `${unit}Fallback "Diffuse"`,
      '}',
      FINAL_TABSTOP,
    ], base);
  },
};

const VF_SHADER_SNIPPET: SnippetDefinition = {
  label: 'vfshader',
  detail: 'Complete pipeline-neutral ShaderLab vertex/fragment Shader',
  body: (base, unit) => {
    const pass = vertexFragmentPassLines(unit, 2, 3)
      .map((line) => `${unit.repeat(2)}${line}`);
    return renderAtCursor([
      `Shader "${placeholder(1, 'Custom/VertexFragment')}"`,
      '{',
      `${unit}SubShader`,
      `${unit}{`,
      ...pass,
      `${unit}}`,
      '}',
    ], base);
  },
};

const ROOT_SNIPPETS: readonly SnippetDefinition[] = [
  SURFACE_SHADER_SNIPPET,
  VF_SHADER_SNIPPET,
];

const BLEND_SNIPPETS: readonly SnippetDefinition[] = [
  blendSnippet(
    'blend',
    'ShaderLab alpha Blend state',
    'SrcAlpha',
    'OneMinusSrcAlpha',
  ),
  blendSnippet('blend-additive', 'ShaderLab additive Blend state', 'One', 'One'),
  blendSnippet(
    'blend-premultiplied',
    'ShaderLab premultiplied-alpha Blend state',
    'One',
    'OneMinusSrcAlpha',
  ),
  blendSnippet('blend-multiply', 'ShaderLab multiply Blend state', 'DstColor', 'Zero'),
];

export function shaderLabSnippetCompletions(
  analysis: DocumentAnalysis | undefined,
  text: string,
  position: Position,
  languageId: string,
  uri: string,
  cursorFacts?: CursorContext,
): CompletionItem[] {
  if (
    !analysis
    || analysis.sourceText !== text
    || languageId !== 'shaderlab'
  ) return [];
  const cursor = cursorFacts ?? analyzeCursor(text, position, languageId, uri);
  if (cursor.lexical !== 'code' || cursor.classification !== 'shaderLabCode') return [];
  const line = analysis.sourceLines[position.line];
  if (line === undefined || position.character > line.length) return [];
  const before = line.slice(0, position.character);
  const after = line.slice(position.character);
  const base = /^\s*/.exec(before)?.[0] ?? '';
  const prefix = before.slice(base.length);
  if (!/^[A-Za-z-]*$/.test(prefix) || after.trim().length > 0) return [];

  const lineLayout = analysis.layout.lines[position.line];
  if (!lineLayout || lineLayout.protected) return [];
  const rootOnly = documentContainsOnlyCurrentPrefix(
    analysis.sourceLines,
    position.line,
    base.length,
    position.character,
  );
  if (!rootOnly && !analysis.layout.safe) return [];
  const definitions = rootOnly
    ? ROOT_SNIPPETS
    : lineLayout.directScope === 'properties'
      ? PROPERTY_SNIPPETS
      : lineLayout.directScope === 'subshader'
        ? [PASS_SNIPPET, VF_PASS_SNIPPET]
        : lineLayout.directScope === 'pass'
          ? [
            ...(passHasProgram(analysis, position.line) ? [] : [PROGRAM_SNIPPET]),
            ...BLEND_SNIPPETS,
          ]
          : [];
  const unit = inferIndentUnit(base, analysis.layout.lines[position.line].indentDepth);
  return definitions.map((definition) => ({
    label: definition.label,
    kind: CompletionItemKind.Snippet,
    detail: definition.detail,
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: {
      range: {
        start: { line: position.line, character: base.length },
        end: position,
      },
      newText: definition.body(base, unit),
    },
    sortText: `2-${definition.label}`,
  }));
}

function propertySnippet(label: string, detail: string, body: string): SnippetDefinition {
  return { label, detail, body: () => body };
}

function blendSnippet(
  label: string,
  detail: string,
  source: string,
  destination: string,
): SnippetDefinition {
  return {
    label,
    detail,
    body: () => `Blend ${placeholder(1, source)} ${placeholder(2, destination)}`,
  };
}

function placeholder(index: number, value: string): string {
  return `\${${index}:${value}}`;
}

function renderAtCursor(lines: readonly string[], base: string): string {
  return lines.map((line, index) => index === 0 ? line : `${base}${line}`).join('\n');
}

function vertexFragmentProgramLines(unit: string, firstTab: number): string[] {
  const vertex = placeholder(firstTab, 'vert');
  const fragment = placeholder(firstTab + 1, 'frag');
  const attributes = placeholder(firstTab + 2, 'Attributes');
  const varyings = placeholder(firstTab + 3, 'Varyings');
  const position = placeholder(firstTab + 4, 'input.positionOS');
  const color = placeholder(firstTab + 5, 'half4(1, 1, 1, 1)');
  return [
    'HLSLPROGRAM',
    `#pragma vertex ${vertex}`,
    `#pragma fragment ${fragment}`,
    '',
    `struct ${attributes}`,
    '{',
    `${unit}float4 positionOS : POSITION;`,
    '};',
    '',
    `struct ${varyings}`,
    '{',
    `${unit}float4 positionCS : SV_POSITION;`,
    '};',
    '',
    `${varyings} ${vertex}(${attributes} input)`,
    '{',
    `${unit}${varyings} output;`,
    `${unit}output.positionCS = ${position};`,
    `${unit}return output;`,
    '}',
    '',
    `half4 ${fragment}(${varyings} input) : SV_Target`,
    '{',
    `${unit}return ${color};`,
    '}',
    'ENDHLSL',
  ];
}

function vertexFragmentPassLines(
  unit: string,
  nameTab: number,
  programTab: number,
): string[] {
  return [
    'Pass',
    '{',
    `${unit}Name "${placeholder(nameTab, 'PASS')}"`,
    ...vertexFragmentProgramLines(unit, programTab).map((line) => `${unit}${line}`),
    `${unit}${FINAL_TABSTOP}`,
    '}',
  ];
}

function documentContainsOnlyCurrentPrefix(
  lines: readonly string[],
  line: number,
  prefixStart: number,
  prefixEnd: number,
): boolean {
  return lines.every((text, index) => (
    index === line
      ? `${text.slice(0, prefixStart)}${text.slice(prefixEnd)}`.trim().length === 0
      : text.trim().length === 0
  ));
}

function passHasProgram(analysis: DocumentAnalysis, line: number): boolean {
  return analysis.layout.scopes.some((scope) => (
    scope.kind === 'pass'
    && scope.headerLine < line
    && line < scope.closeLine
    && scope.hasProgramBlock
  ));
}

function inferIndentUnit(base: string, depth: number): string {
  if (base.includes('\t')) return '\t';
  if (depth > 0 && base.length >= depth && base.length % depth === 0) {
    return ' '.repeat(base.length / depth);
  }
  return '    ';
}
