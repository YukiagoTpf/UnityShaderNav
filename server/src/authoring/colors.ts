import type {
  Color,
  ColorInformation,
  ColorPresentation,
  Range,
} from 'vscode-languageserver/node';
import type { DocumentAnalysis } from '../analysis';

export function shaderLabDocumentColors(
  analysis: DocumentAnalysis | undefined,
): ColorInformation[] {
  if (!analysis?.layout.safe) return [];
  return analysis.shaderLabProperties.literalColors
    .filter((fact) => !fact.hdr && normalized(fact.components))
    .map((fact) => ({
      range: fact.range,
      color: {
        red: fact.components[0],
        green: fact.components[1],
        blue: fact.components[2],
        alpha: fact.components[3],
      },
    }));
}

export function shaderLabColorPresentations(
  analysis: DocumentAnalysis | undefined,
  range: Range,
  color: Color,
): ColorPresentation[] {
  if (!analysis?.layout.safe || !normalized([
    color.red,
    color.green,
    color.blue,
    color.alpha,
  ])) return [];
  const fact = analysis.shaderLabProperties.literalColors.find((candidate) => (
    !candidate.hdr && sameRange(candidate.range, range)
  ));
  if (!fact || !normalized(fact.components)) return [];
  const label = `(${formatComponent(color.red)}, ${formatComponent(color.green)}, ${formatComponent(color.blue)}, ${formatComponent(color.alpha)})`;
  return [{
    label,
    textEdit: { range, newText: label },
  }];
}

function normalized(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

function sameRange(left: Range, right: Range): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function formatComponent(value: number): string {
  const rounded = Math.fround(value);
  if (Object.is(rounded, -0)) return '0';
  for (let precision = 1; precision <= 9; precision++) {
    const candidate = Number(rounded.toPrecision(precision)).toString();
    if (Math.fround(Number(candidate)) === rounded) return candidate;
  }
  return rounded.toString();
}
