import type {
  CSharpCurrentSourceParams,
  CSharpCurrentSourceResult,
} from '@unity-shader-nav/shared';
import { CSHARP_CURRENT_SOURCE_REQUEST } from '@unity-shader-nav/shared';
import type { Connection } from 'vscode-languageserver/node';
import type {
  CSharpCurrentSourceProvider,
  CSharpCurrentSourceSnapshot,
} from './csharpPropertySource';

function validResult(
  value: unknown,
): value is CSharpCurrentSourceResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CSharpCurrentSourceResult>;
  return typeof candidate.text === 'string'
    && (
      candidate.availability === 'open-buffer'
      || candidate.availability === 'closed-saved'
    );
}

/**
 * Pull the exact observable C# text from the VS Code client without
 * registering a C# language provider or adding C# to the language client's
 * document selector.
 */
export class CSharpCurrentSourceClient implements CSharpCurrentSourceProvider {
  constructor(
    private readonly connection: Pick<Connection, 'sendRequest'>,
  ) {}

  async currentSourceFor(uri: string): Promise<CSharpCurrentSourceSnapshot | null> {
    try {
      const params: CSharpCurrentSourceParams = { uri };
      const result = await this.connection.sendRequest<unknown>(
        CSHARP_CURRENT_SOURCE_REQUEST,
        params,
      );
      return validResult(result)
        ? { text: result.text, availability: result.availability }
        : null;
    } catch {
      return null;
    }
  }
}
