import { describe, expect, it, vi } from 'vitest';
import type { IndexStatusSnapshot } from '@unity-shader-nav/shared';
import {
  IndexStatusController,
  indexStatusDetails,
  projectIndexStatus,
} from '../../../client/src/indexStatus';
import {
  SHOW_INDEX_STATUS_COMMAND,
  SHOW_OUTPUT_COMMAND,
  presentStatus,
} from '../../../client/src/statusPresentation';

function snapshot(
  statusSequence: number,
  workspaces: IndexStatusSnapshot['workspaces'] = [],
): IndexStatusSnapshot {
  return { statusSequence, workspaces };
}

describe('client index status projection', () => {
  it('turns a failed status into an actionable output-channel presentation', () => {
    expect(presentStatus(
      'failed',
      '1 root',
      'file:///failed: [indexing] parser unavailable',
    )).toEqual({
      text: '$(error) UnityShaderNav: failed (1 root)',
      tooltip: [
        'file:///failed: [indexing] parser unavailable',
        '',
        'Click to open the UnityShaderNav output channel.',
      ].join('\n'),
      command: SHOW_OUTPUT_COMMAND,
      background: 'error',
    });
  });

  it('turns indexing into a spinning status with a workspace-details action', () => {
    expect(presentStatus('indexing', '2 roots', 'file:///one: initial')).toEqual({
      text: '$(sync~spin) UnityShaderNav: indexing… (2 roots)',
      tooltip: [
        'file:///one: initial',
        '',
        'Click to view workspace index details.',
      ].join('\n'),
      command: SHOW_INDEX_STATUS_COMMAND,
    });
  });

  it('turns ready into a positive status with a workspace-details action', () => {
    expect(presentStatus('ready')).toEqual({
      text: '$(check) UnityShaderNav: ready',
      tooltip: 'Click to view workspace index details.',
      command: SHOW_INDEX_STATUS_COMMAND,
    });
  });

  it('keeps non-error lifecycle states clickable for status details', () => {
    expect((['starting', 'standalone', 'stopped'] as const).map((mode) => (
      presentStatus(mode)
    ))).toEqual([
      {
        text: '$(sync~spin) UnityShaderNav: starting…',
        tooltip: 'Click to view workspace index details.',
        command: SHOW_INDEX_STATUS_COMMAND,
      },
      {
        text: '$(circle-outline) UnityShaderNav: standalone mode',
        tooltip: 'Click to view workspace index details.',
        command: SHOW_INDEX_STATUS_COMMAND,
      },
      {
        text: '$(circle-slash) UnityShaderNav: stopped',
        tooltip: 'Click to view workspace index details.',
        command: SHOW_INDEX_STATUS_COMMAND,
      },
    ]);
  });

  it('projects an empty snapshot to standalone', () => {
    expect(projectIndexStatus(snapshot(0))).toEqual({ mode: 'standalone' });
  });

  it('describes each workspace through user-facing index status details', () => {
    expect(indexStatusDetails(snapshot(8, [
      {
        folderUri: 'file:///ready',
        mode: 'unity',
        lifecycle: { state: 'ready', revision: 3, warningCount: 1 },
      },
      {
        folderUri: 'file:///indexing',
        mode: 'standalone',
        lifecycle: { state: 'indexing', operation: 'rebuild', servingRevision: 2 },
      },
      {
        folderUri: 'file:///failed',
        mode: 'unity',
        lifecycle: {
          state: 'failed',
          servingRevision: 4,
          failure: {
            category: 'package-resolution',
            message: 'Packages/packages-lock.json is malformed',
          },
        },
      },
    ]))).toEqual([
      {
        label: '$(check) Ready',
        description: 'Unity project',
        detail: 'file:///ready · revision 3 · 1 warning',
      },
      {
        label: '$(sync~spin) Indexing',
        description: 'rebuild',
        detail: 'file:///indexing · serving revision 2',
      },
      {
        label: '$(error) Failed',
        description: 'package-resolution',
        detail: 'file:///failed · serving revision 4 · Packages/packages-lock.json is malformed',
      },
    ]);
  });

  it('keeps standalone status details visible without workspace roots', () => {
    expect(indexStatusDetails(snapshot(0))).toEqual([{
      label: '$(circle-outline) Standalone mode',
      detail: 'No workspace root is currently indexed.',
    }]);
  });

  it('keeps status details neutral when no current snapshot is available', () => {
    expect(indexStatusDetails(undefined)).toEqual([{
      label: '$(info) Status unavailable',
      detail: 'No current workspace index status snapshot is available.',
    }]);
  });

  it('uses failed over indexing and ready while retaining actionable root details', () => {
    const result = projectIndexStatus(snapshot(8, [
      {
        folderUri: 'file:///ready',
        mode: 'unity',
        lifecycle: { state: 'ready', revision: 3, warningCount: 0 },
      },
      {
        folderUri: 'file:///indexing',
        mode: 'standalone',
        lifecycle: { state: 'indexing', operation: 'initial' },
      },
      {
        folderUri: 'file:///failed',
        mode: 'unity',
        lifecycle: {
          state: 'failed',
          failure: {
            category: 'package-resolution',
            message: 'Packages/packages-lock.json is malformed',
          },
        },
      },
    ]));

    expect(result).toEqual({
      mode: 'failed',
      detail: '1 root',
      tooltip: 'file:///failed: [package-resolution] Packages/packages-lock.json is malformed',
    });
  });

  it('accepts only newer snapshots within a session and accepts sequence zero after reset', () => {
    const statusBar = { set: vi.fn() };
    const controller = new IndexStatusController(statusBar);
    const ready = snapshot(4, [{
      folderUri: 'file:///project',
      mode: 'unity',
      lifecycle: { state: 'ready', revision: 1, warningCount: 0 },
    }]);

    const initialSession = controller.session();
    expect(controller.accept(ready, initialSession)).toBe(true);
    expect(controller.accept(ready, initialSession)).toBe(false);
    expect(controller.accept(snapshot(3), initialSession)).toBe(false);
    expect(statusBar.set).toHaveBeenCalledTimes(1);
    expect(statusBar.set).toHaveBeenLastCalledWith('ready', undefined, undefined);

    controller.reset();
    expect(statusBar.set).toHaveBeenLastCalledWith('starting');
    expect(controller.accept(snapshot(0), controller.session())).toBe(true);
    expect(statusBar.set).toHaveBeenLastCalledWith('standalone', undefined, undefined);

    const stoppedSession = controller.session();
    controller.stop();
    expect(statusBar.set).toHaveBeenLastCalledWith('stopped');
    expect(controller.accept(snapshot(99), stoppedSession)).toBe(false);
    controller.reset();
    expect(controller.accept(snapshot(0), controller.session())).toBe(true);
    expect(controller.current()).toEqual(snapshot(0));
  });
});
