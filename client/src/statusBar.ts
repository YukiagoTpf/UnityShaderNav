import * as vscode from 'vscode';

export type StatusMode =
  | 'starting'
  | 'indexing'
  | 'ready'
  | 'standalone'
  | 'failed'
  | 'stopped';

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.set('starting');
    this.item.show();
  }

  set(mode: StatusMode, detail?: string, tooltip?: string): void {
    const labels: Record<StatusMode, string> = {
      starting: 'UnityShaderNav: starting…',
      indexing: 'UnityShaderNav: indexing…',
      ready: 'UnityShaderNav: ready',
      standalone: 'UnityShaderNav: standalone mode',
      failed: 'UnityShaderNav: failed',
      stopped: 'UnityShaderNav: stopped',
    };
    this.item.text = labels[mode] + (detail ? ` (${detail})` : '');
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}
