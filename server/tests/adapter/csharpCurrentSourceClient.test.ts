import { describe, expect, it, vi } from 'vitest';
import { CSHARP_CURRENT_SOURCE_REQUEST } from '@unity-shader-nav/shared';
import { CSharpCurrentSourceClient } from '../../src/adapter/csharpCurrentSourceClient';

describe('CSharpCurrentSourceClient', () => {
  it('requests exact current source from the client', async () => {
    const sendRequest = vi.fn(async () => ({
      text: 'class ShaderController {}',
      availability: 'open-buffer',
    }));
    const provider = new CSharpCurrentSourceClient({ sendRequest } as never);

    await expect(provider.currentSourceFor(
      'file:///project/Assets/ShaderController.cs',
    )).resolves.toEqual({
      text: 'class ShaderController {}',
      availability: 'open-buffer',
    });
    expect(sendRequest).toHaveBeenCalledWith(
      CSHARP_CURRENT_SOURCE_REQUEST,
      { uri: 'file:///project/Assets/ShaderController.cs' },
    );
  });

  it('accepts an exact closed-saved snapshot', async () => {
    const provider = new CSharpCurrentSourceClient({
      sendRequest: async () => ({
        text: 'class Saved {}',
        availability: 'closed-saved',
      }),
    } as never);

    await expect(provider.currentSourceFor('file:///project/Assets/Saved.cs'))
      .resolves.toEqual({
        text: 'class Saved {}',
        availability: 'closed-saved',
      });
  });

  it.each([
    null,
    {},
    { text: 42, availability: 'open-buffer' },
    { text: 'class X {}', availability: 'stale' },
  ])('rejects a malformed client result %#', async (result) => {
    const provider = new CSharpCurrentSourceClient({
      sendRequest: async () => result,
    } as never);

    await expect(provider.currentSourceFor('file:///project/Assets/X.cs'))
      .resolves.toBeNull();
  });

  it('degrades request failure to unknown current source', async () => {
    const provider = new CSharpCurrentSourceClient({
      sendRequest: async () => {
        throw new Error('client stopped');
      },
    } as never);

    await expect(provider.currentSourceFor('file:///project/Assets/X.cs'))
      .resolves.toBeNull();
  });
});
