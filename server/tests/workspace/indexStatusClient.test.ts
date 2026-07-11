import { describe, expect, it, vi } from 'vitest';
import type { IndexStatusSnapshot } from '@unity-shader-nav/shared';
import {
  IndexStatusController,
  projectIndexStatus,
} from '../../../client/src/indexStatus';

function snapshot(
  statusSequence: number,
  workspaces: IndexStatusSnapshot['workspaces'] = [],
): IndexStatusSnapshot {
  return { statusSequence, workspaces };
}

describe('client index status projection', () => {
  it('projects an empty snapshot to standalone', () => {
    expect(projectIndexStatus(snapshot(0))).toEqual({ mode: 'standalone' });
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
