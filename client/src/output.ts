import type { IndexStatusDetail } from './indexStatus';

export interface ClientOutput {
  appendLine(value: string): void;
}

export type ClientErrorReporter = (message: string, error: unknown) => void;

export function reportClientError(
  output: ClientOutput,
  message: string,
  error: unknown,
): void {
  const detail = error instanceof Error
    ? error.stack ?? `${error.name}: ${error.message}`
    : String(error);
  output.appendLine(`[Error] ${message}\n${detail}`);
}

export function reportIndexStatus(
  output: ClientOutput,
  details: readonly IndexStatusDetail[],
): void {
  output.appendLine('[Index Status]');
  for (const status of details) {
    output.appendLine([
      status.label.replace(/^\$\([^)]+\)\s*/, ''),
      status.description,
      status.detail,
    ].filter((part): part is string => part !== undefined).join(' · '));
  }
}
