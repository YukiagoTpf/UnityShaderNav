import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREVIEW_PROPERTY_RENAME_COMMAND } from '@unity-shader-nav/shared';

const root = resolve(__dirname, '../../..');

describe('safe Property Rename command wiring', () => {
  it('contributes and registers the explicit preview command', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(root, 'client/package.json'), 'utf8'),
    ) as {
      contributes?: { commands?: Array<{ command?: string }> };
    };
    const extension = await readFile(
      resolve(root, 'client/src/extension.ts'),
      'utf8',
    );
    expect(
      manifest.contributes?.commands?.filter(
        ({ command }) => command === PREVIEW_PROPERTY_RENAME_COMMAND,
      ),
    ).toHaveLength(1);
    expect(extension).toContain('registerPropertyRenameCommand(client, reportError)');
  });

  it('keeps the transaction outside generic C# providers', async () => {
    const source = await readFile(
      resolve(root, 'client/src/propertyRename.ts'),
      'utf8',
    );
    expect(source).toContain('workspace.applyEdit');
    expect(source).toContain('PROPERTY_RENAME_FINISH_REQUEST');
    expect(source).not.toMatch(/register(?:Definition|Reference|Rename|Diagnostic)Provider/);
  });
});
