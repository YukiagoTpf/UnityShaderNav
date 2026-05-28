import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarkupKind, type MarkupContent } from 'vscode-languageserver/node';
import type { FunctionSymbolEntry, SymbolEntry } from '@unity-shader-nav/shared';
import type { BuiltinCategory, BuiltinEntry } from '../suggestions/builtins';

export interface ProjectHoverInput {
  source: 'project';
  symbol: SymbolEntry;
  /** Optional workspace root URI for relativizing the source-location footer. */
  workspaceRootUri?: string;
}

export interface BuiltinHoverInput {
  source: 'builtin';
  entry: BuiltinEntry;
}

export type HoverInput = ProjectHoverInput | BuiltinHoverInput;

const CATEGORY_LABEL: Record<BuiltinCategory, string> = {
  hlsl: 'HLSL built-in',
  unitycg: 'Unity built-in',
  urp: 'URP built-in',
  shaderlab: 'ShaderLab built-in',
  semantic: 'HLSL semantic',
};

/** Format a single candidate into a markdown MarkupContent block (no separator). */
export function formatHoverCandidate(input: HoverInput): MarkupContent {
  if (input.source === 'builtin') {
    return { kind: MarkupKind.Markdown, value: formatBuiltinValue(input.entry) };
  }
  return {
    kind: MarkupKind.Markdown,
    value: formatProjectValue(input.symbol, input.workspaceRootUri),
  };
}

/** Format up to N candidates as a single MarkupContent, joining with `---`. */
export function formatHoverCandidates(
  inputs: HoverInput[],
  maxCandidates: number = 5,
): MarkupContent {
  if (inputs.length === 0) {
    return { kind: MarkupKind.Markdown, value: '' };
  }
  if (inputs.length === 1) {
    return formatHoverCandidate(inputs[0]);
  }

  const shown = Math.min(inputs.length, maxCandidates);
  const parts: string[] = [];
  parts.push(`**${shown} candidates**`);
  for (let i = 0; i < shown; i++) {
    parts.push(formatHoverCandidate(inputs[i]).value);
  }
  let value = parts.join('\n\n---\n\n');
  if (inputs.length > maxCandidates) {
    const extra = inputs.length - maxCandidates;
    value += `\n\n_… and ${extra} more candidates_`;
  }
  return { kind: MarkupKind.Markdown, value };
}

// ---------------------------------------------------------------------------
// Project symbol formatting
// ---------------------------------------------------------------------------

function formatProjectValue(symbol: SymbolEntry, workspaceRootUri: string | undefined): string {
  const code = renderSymbolCode(symbol);
  const lines: string[] = [];
  lines.push(fence(code));

  if (symbol.kind === 'structMember' && symbol.parentType) {
    lines.push(`_member of_ \`${symbol.parentType}\``);
  }

  lines.push(renderFooter(symbol, workspaceRootUri));
  return lines.join('\n\n');
}

function renderSymbolCode(symbol: SymbolEntry): string {
  switch (symbol.kind) {
    case 'function': {
      const fn = symbol as FunctionSymbolEntry;
      return renderFunctionSignature(fn);
    }
    case 'struct':
      return `struct ${symbol.name}`;
    case 'structMember':
      return `${symbol.declaredType ?? 'unknown'} ${symbol.name};`;
    case 'variable':
      return `${symbol.declaredType ?? 'unknown'} ${symbol.name};`;
    case 'parameter':
      return `${symbol.declaredType ?? 'unknown'} ${symbol.name}`;
    case 'localVariable':
      return `${symbol.declaredType ?? 'unknown'} ${symbol.name};`;
    case 'macro':
      return `#define ${symbol.name}`;
    case 'cbuffer':
      return `cbuffer ${symbol.name}`;
    default:
      return symbol.name;
  }
}

function renderFunctionSignature(fn: FunctionSymbolEntry): string {
  // Match signatureLabelOf from suggestions/format.ts exactly:
  //   ${returnType ?? declaredType ?? 'void'} ${name}(${params})
  // where params joins `${type} ${name}` with `, `.
  const returnType = fn.returnType ?? fn.declaredType ?? 'void';
  const params =
    fn.parameters?.map((p) => `${p.type} ${p.name}`).join(', ') ?? '';
  return `${returnType} ${fn.name}(${params})`;
}

function safeFileURLToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function uriBasename(uri: string): string {
  const withoutQuery = uri.replace(/[?#].*$/, '');
  const lastSlash = withoutQuery.lastIndexOf('/');
  const tail = lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function renderFooter(symbol: SymbolEntry, workspaceRootUri: string | undefined): string {
  const absPath = safeFileURLToPath(symbol.location.uri);
  let display: string;
  if (absPath === undefined) {
    // Non-file URI (or a URI that node refuses to parse on this platform):
    // fall back to a basename derived from the URI itself rather than
    // crashing the hover.
    display = uriBasename(symbol.location.uri);
  } else if (workspaceRootUri) {
    const rootPath = safeFileURLToPath(workspaceRootUri);
    if (rootPath !== undefined) {
      const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
      display = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : path.basename(absPath);
    } else {
      display = path.basename(absPath);
    }
  } else {
    display = path.basename(absPath);
  }
  // Normalize to forward slashes for cross-OS display consistency.
  display = display.split(path.sep).join('/');
  const line = symbol.location.range.start.line + 1;
  return `_in_ \`${display}\`:${line}`;
}

// ---------------------------------------------------------------------------
// Built-in entry formatting
// ---------------------------------------------------------------------------

function formatBuiltinValue(entry: BuiltinEntry): string {
  const lines: string[] = [];
  lines.push(fence(renderBuiltinCode(entry)));
  if (entry.documentation) {
    lines.push(entry.documentation);
  }
  lines.push(`_${CATEGORY_LABEL[entry.category]}_`);
  return lines.join('\n\n');
}

function renderBuiltinCode(entry: BuiltinEntry): string {
  if (entry.kind === 'function' && entry.parameters) {
    const returnType = entry.returnType ?? 'void';
    const params = entry.parameters
      .map((p) => `${p.type} ${p.name}`)
      .join(', ');
    return `${returnType} ${entry.name}(${params})`;
  }
  return entry.detail ?? entry.name;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fence(code: string): string {
  return '```hlsl\n' + code + '\n```';
}
