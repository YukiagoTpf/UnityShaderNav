import { describe, expect, it, vi } from 'vitest';
import {
  reportAdapterStatus,
  reportClientError,
  reportIndexStatus,
} from '../../../client/src/output';

describe('client output reporting', () => {
  it('writes actionable context and the original error to the shared output', () => {
    const output = { appendLine: vi.fn() };

    reportClientError(output, 'Failed to refresh index status', new Error('transport unavailable'));

    expect(output.appendLine).toHaveBeenCalledTimes(1);
    expect(output.appendLine.mock.calls[0][0]).toMatch(
      /^\[Error\] Failed to refresh index status\nError: transport unavailable/m,
    );
  });

  it('writes the current failed root details before opening shared output', () => {
    const output = { appendLine: vi.fn() };

    reportIndexStatus(output, [{
      label: '$(error) Failed',
      description: 'package-resolution',
      detail: 'file:///project · Packages/packages-lock.json is malformed',
    }]);

    expect(output.appendLine.mock.calls.map(([line]) => line)).toEqual([
      '[Index Status]',
      'Failed · package-resolution · file:///project · Packages/packages-lock.json is malformed',
    ]);
  });

  it('writes every Adapter capability reported by the server', () => {
    const output = { appendLine: vi.fn() };

    reportAdapterStatus(output, {
      mode: 'adapter',
      capabilities: {
        unityVersion: '2022.3.62f1',
        projectId: 'project-a',
        adapterVersion: '0.1.0',
        supportedFeatures: ['adapter-status'],
      },
    });

    expect(output.appendLine).toHaveBeenCalledWith(
      '[Adapter] Connected · Unity 2022.3.62f1 · project project-a · Adapter 0.1.0 · features: adapter-status',
    );
  });

  it('writes the Standalone fallback reason', () => {
    const output = { appendLine: vi.fn() };

    reportAdapterStatus(output, {
      mode: 'standalone',
      reason: 'no-adapter',
    });

    expect(output.appendLine).toHaveBeenCalledWith(
      '[Adapter] Standalone · no Adapter available',
    );
  });
});
