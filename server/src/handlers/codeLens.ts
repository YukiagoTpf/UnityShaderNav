import {
  OPEN_VARIANT_COST_DOCUMENTATION_COMMAND,
} from '@unity-shader-nav/shared';
import type {
  CodeLens,
  Connection,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  analyzeDeclaredVariantCosts,
  type DeclaredVariantContribution,
  type DeclaredVariantPragma,
  type DeclaredVariantProgramCost,
} from '../parser/preproc/declaredVariantCost';
import { isShaderLabUri } from '../sourceLocation';

interface ContributionReference {
  readonly program: DeclaredVariantProgramCost;
  readonly contribution: DeclaredVariantContribution;
}

interface OrderedCodeLens {
  readonly lens: CodeLens;
  readonly priority: number;
}

export function registerCodeLensHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
): void {
  connection.onCodeLens((params): CodeLens[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    return declaredVariantCostCodeLenses(
      params.textDocument.uri,
      document.getText(),
    );
  });
}

export function declaredVariantCostCodeLenses(uri: string, text: string): CodeLens[] {
  const analysis = analyzeDeclaredVariantCosts(text, isShaderLabUri(uri));
  const sourceLines = text.split(/\r?\n/);
  const references = new Map<DeclaredVariantPragma, ContributionReference[]>();
  const ordered: OrderedCodeLens[] = [];

  for (const program of analysis.programs) {
    if (program.uniqueSetCount === 0) continue;
    ordered.push({
      lens: lensAtLine(
        program.startLine,
        sourceLines,
        programTitle(program),
      ),
      priority: 0,
    });
    for (const contribution of program.contributions) {
      const existing = references.get(contribution.pragma) ?? [];
      existing.push({ program, contribution });
      references.set(contribution.pragma, existing);
    }
  }

  for (const pragma of analysis.pragmas) {
    ordered.push({
      lens: lensAtLine(
        pragma.line,
        sourceLines,
        pragmaTitle(pragma, references.get(pragma) ?? []),
      ),
      priority: 1,
    });
  }

  return ordered
    .sort((left, right) => (
      left.lens.range.start.line - right.lens.range.start.line
      || left.priority - right.priority
      || (left.lens.command?.title ?? '').localeCompare(right.lens.command?.title ?? '')
    ))
    .map(({ lens }) => lens);
}

function lensAtLine(line: number, sourceLines: readonly string[], title: string): CodeLens {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: sourceLines[line]?.length ?? 0 },
    },
    command: {
      title,
      command: OPEN_VARIANT_COST_DOCUMENTATION_COMMAND,
    },
  };
}

function programTitle(program: DeclaredVariantProgramCost): string {
  const setLabel = program.uniqueSetCount === 1 ? 'set' : 'sets';
  return [
    `Declared/static program upper bound: ${program.upperBound.toString()} variants`,
    `${program.uniqueSetCount} unique ${setLabel}`,
    `largest ×${program.largestMultiplier}`,
    'why build counts differ',
  ].join(' · ');
}

function pragmaTitle(
  pragma: DeclaredVariantPragma,
  references: readonly ContributionReference[],
): string {
  const parts = [
    `Declared/static set ×${pragma.multiplier}`,
    `scope ${pragma.local ? 'local' : 'global'}/${pragma.stage ?? 'all stages'}`,
  ];
  if (pragma.duplicateOptions) parts.push('repeated options normalized');
  if (pragma.conditional) parts.push('conditional declaration');

  if (references.length === 0) {
    parts.push('no matching program in this source');
  } else if (references.length === 1) {
    const [{ program, contribution }] = references;
    if (contribution.duplicateSet) parts.push('duplicate set contributes ×1');
    parts.push(`program upper bound ${program.upperBound.toString()}`);
  } else {
    const duplicateCount = references.filter(({ contribution }) => contribution.duplicateSet).length;
    parts.push(`shared by ${references.length} programs`);
    if (duplicateCount > 0) {
      parts.push(`duplicate set contributes ×1 in ${duplicateCount}`);
    }
    const bounds = [...new Set(references.map(({ program }) => program.upperBound.toString()))]
      .map((value) => BigInt(value))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const boundLabel = bounds.length === 1
      ? bounds[0].toString()
      : `${bounds[0].toString()}–${bounds[bounds.length - 1].toString()}`;
    parts.push(`program upper bounds ${boundLabel}`);
  }

  parts.push('why build counts differ');
  return parts.join(' · ');
}
