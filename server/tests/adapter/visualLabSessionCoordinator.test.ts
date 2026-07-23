import { describe, expect, it, vi } from 'vitest';
import type {
  AdapterStatus,
  MaterialContextResult,
  VisualLabStateChangedParams,
} from '@unity-shader-nav/shared';
import {
  VisualLabSessionCoordinator,
} from '../../src/adapter/visualLabSessionCoordinator';

class FakeAdapters {
  stateForFolder(): {
    readonly status: 'unavailable';
    readonly reason: 'no-adapter';
  } {
    return { status: 'unavailable', reason: 'no-adapter' };
  }

  rpcForFolder(): undefined {
    return undefined;
  }

  onDidChangeStatus(
    _listener: (status: AdapterStatus) => void,
  ): { dispose(): void } {
    return { dispose() {} };
  }
}

function manager() {
  return {
    workspaceFor(uri: string) {
      if (!uri.startsWith('file:///project/')) return undefined;
      return { folderUri: 'file:///project' };
    },
    async materialContextFor(): Promise<MaterialContextResult> {
      return { status: 'unavailable', reason: 'no-adapter' };
    },
    async selectedIncludePointContextFor() {
      return undefined;
    },
  };
}

describe('VisualLabSessionCoordinator', () => {
  it('routes one stable session per document and rejects unknown workspaces', () => {
    const coordinator = new VisualLabSessionCoordinator({
      manager: manager() as never,
      adapters: new FakeAdapters() as never,
      publish() {},
    });
    const uri = 'file:///project/Assets/Probe.shader';

    expect(coordinator.serviceFor(uri)).toBe(coordinator.serviceFor(uri));
    expect(coordinator.serviceFor('file:///foreign/Probe.shader')).toBeUndefined();
  });

  it('publishes the owning URI and never another document session', () => {
    const publish = vi.fn<(params: VisualLabStateChangedParams) => void>();
    const coordinator = new VisualLabSessionCoordinator({
      manager: manager() as never,
      adapters: new FakeAdapters() as never,
      publish,
    });
    const first = 'file:///project/Assets/First.shader';
    const second = 'file:///project/Assets/Second.shader';
    coordinator.serviceFor(first);
    coordinator.markSourceChanged(first);
    coordinator.serviceFor(second);
    coordinator.markShaderContextChanged(second);

    expect(publish.mock.calls.map(([params]) => params.textDocument.uri))
      .toEqual([first, second]);
  });

  it('disposes all session listeners without publishing retained state', () => {
    const publish = vi.fn();
    const coordinator = new VisualLabSessionCoordinator({
      manager: manager() as never,
      adapters: new FakeAdapters() as never,
      publish,
    });
    const service = coordinator.serviceFor(
      'file:///project/Assets/Probe.shader',
    )!;

    coordinator.dispose();
    service.markSelectionChanged();

    expect(publish).not.toHaveBeenCalled();
    expect(coordinator.serviceFor(
      'file:///project/Assets/Probe.shader',
    )).toBeUndefined();
  });
});
