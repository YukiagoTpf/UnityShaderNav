import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem,
} from 'vscode-languageserver/node';
import type { Position } from '@unity-shader-nav/shared';
import type { DocumentAnalysis } from '../analysis';
import { analyzeCursor } from '../parser/lexical/cursor';

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

const PASS_SNIPPET: SnippetDefinition = {
  label: 'pass',
  detail: 'ShaderLab Pass skeleton',
  body: (base, unit) => [
    'Pass',
    `${base}{`,
    `${base}${unit}Name "\${1:PASS}"`,
    `${base}${unit}\${0}`,
    `${base}}`,
  ].join('\n'),
};

const PROGRAM_SNIPPET: SnippetDefinition = {
  label: 'vertex-fragment-program',
  detail: 'Pipeline-neutral HLSL vertex/fragment skeleton; choose the clip-space transform explicitly',
  body: (base, unit) => [
    'HLSLPROGRAM',
    `${base}#pragma vertex \${1:vert}`,
    `${base}#pragma fragment \${2:frag}`,
    '',
    `${base}struct \${3:Attributes}`,
    `${base}{`,
    `${base}${unit}float4 positionOS : POSITION;`,
    `${base}};`,
    '',
    `${base}struct \${4:Varyings}`,
    `${base}{`,
    `${base}${unit}float4 positionCS : SV_POSITION;`,
    `${base}};`,
    '',
    `${base}\${4:Varyings} \${1:vert}(\${3:Attributes} input)`,
    `${base}{`,
    `${base}${unit}\${4:Varyings} output;`,
    `${base}${unit}output.positionCS = \${5:input.positionOS};`,
    `${base}${unit}return output;`,
    `${base}}`,
    '',
    `${base}half4 \${2:frag}(\${4:Varyings} input) : SV_Target`,
    `${base}{`,
    `${base}${unit}return \${6:half4(1, 1, 1, 1)};`,
    `${base}}`,
    `${base}ENDHLSL`,
    `${base}\${0}`,
  ].join('\n'),
};

export function shaderLabSnippetCompletions(
  analysis: DocumentAnalysis | undefined,
  text: string,
  position: Position,
  languageId: string,
  uri: string,
): CompletionItem[] {
  if (!analysis?.layout.safe || languageId !== 'shaderlab') return [];
  const cursor = analyzeCursor(text, position, languageId, uri);
  if (cursor.lexical !== 'code' || cursor.classification !== 'shaderLabCode') return [];
  const line = text.split(/\r?\n/)[position.line];
  if (line === undefined || position.character > line.length) return [];
  const before = line.slice(0, position.character);
  const after = line.slice(position.character);
  const base = /^\s*/.exec(before)?.[0] ?? '';
  const prefix = before.slice(base.length);
  if (!/^[A-Za-z-]*$/.test(prefix) || after.trim().length > 0) return [];

  const lineLayout = analysis.layout.lines[position.line];
  if (!lineLayout || lineLayout.protected) return [];
  const definitions = lineLayout.directScope === 'properties'
    ? PROPERTY_SNIPPETS
    : lineLayout.directScope === 'subshader'
      ? [PASS_SNIPPET]
      : lineLayout.directScope === 'pass' && !passHasProgram(analysis, position.line)
        ? [PROGRAM_SNIPPET]
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
