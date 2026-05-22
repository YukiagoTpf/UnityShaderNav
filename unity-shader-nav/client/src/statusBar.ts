import * as vscode from 'vscode';

export type StatusMode = 'starting' | 'ready' | 'standalone' | 'error';

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

  set(mode: StatusMode, detail?: string): void {
    const labels: Record<StatusMode, string> = {
      starting: 'UnityShaderNav: starting…',
      ready: 'UnityShaderNav: ready',
      standalone: 'UnityShaderNav: standalone mode',
      error: 'UnityShaderNav: error',
    };
    this.item.text = labels[mode] + (detail ? ` (${detail})` : '');
  }

  dispose(): void {
    this.item.dispose();
  }
}
