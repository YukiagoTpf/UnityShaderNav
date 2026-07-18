import * as vscode from 'vscode';
import { presentStatus, type StatusMode } from './statusPresentation';

export type { StatusMode } from './statusPresentation';

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
    const presentation = presentStatus(mode, detail, tooltip);
    this.item.text = presentation.text;
    this.item.tooltip = presentation.tooltip;
    this.item.command = presentation.command;
    this.item.backgroundColor = presentation.background === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
