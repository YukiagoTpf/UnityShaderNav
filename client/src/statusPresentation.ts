export const SHOW_INDEX_STATUS_COMMAND = 'unityShaderNav.showIndexStatus';
export const SHOW_OUTPUT_COMMAND = 'unityShaderNav.showOutput';

export type StatusMode =
  | 'starting'
  | 'indexing'
  | 'ready'
  | 'standalone'
  | 'failed'
  | 'stopped';

export interface StatusPresentation {
  readonly text: string;
  readonly tooltip: string;
  readonly command: string;
  readonly background?: 'error';
}

const STATUS_TEXT: Record<StatusMode, string> = {
  starting: '$(sync~spin) UnityShaderNav: starting…',
  indexing: '$(sync~spin) UnityShaderNav: indexing…',
  ready: '$(check) UnityShaderNav: ready',
  standalone: '$(circle-outline) UnityShaderNav: standalone mode',
  failed: '$(error) UnityShaderNav: failed',
  stopped: '$(circle-slash) UnityShaderNav: stopped',
};

const STATUS_DETAILS_HINT = 'Click to view workspace index details.';
const OUTPUT_HINT = 'Click to open the UnityShaderNav output channel.';

export function presentStatus(
  mode: StatusMode,
  detail?: string,
  tooltip?: string,
): StatusPresentation {
  const failed = mode === 'failed';
  const hint = failed ? OUTPUT_HINT : STATUS_DETAILS_HINT;
  return {
    text: STATUS_TEXT[mode] + (detail ? ` (${detail})` : ''),
    tooltip: tooltip ? `${tooltip}\n\n${hint}` : hint,
    command: failed ? SHOW_OUTPUT_COMMAND : SHOW_INDEX_STATUS_COMMAND,
    ...(failed ? { background: 'error' as const } : {}),
  };
}
