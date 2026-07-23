import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '../../..');
const clientSourceRoot = join(repositoryRoot, 'client/src');

describe('C# language tooling coexistence', () => {
  it('does not add C# to the language-client document selector', () => {
    const client = readFileSync(join(clientSourceRoot, 'client.ts'), 'utf8');
    expect(client).not.toMatch(/language\s*:\s*['"]csharp['"]/);
  });

  it('does not contribute C# language ownership or activation', () => {
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, 'client/package.json'), 'utf8'),
    ) as {
      activationEvents?: readonly string[];
      contributes?: {
        languages?: readonly { readonly id?: string }[];
      };
    };
    expect(manifest.activationEvents ?? []).not.toContain('onLanguage:csharp');
    expect((manifest.contributes?.languages ?? []).map(({ id }) => id))
      .not.toContain('csharp');
  });

  it('observes C# revisions only through the narrow custom request bridge', () => {
    const bridge = readFileSync(
      join(clientSourceRoot, 'csharpCurrentSource.ts'),
      'utf8',
    );
    expect(bridge).toContain('CSHARP_CURRENT_SOURCE_REQUEST');
    expect(bridge).toContain('workspace.textDocuments');
    expect(bridge).toContain('workspace.fs.readFile');
    expect(bridge).not.toMatch(/\blanguages\.register\w*Provider\s*\(/);
  });
});
