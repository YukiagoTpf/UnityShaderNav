import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

function projectA(): string {
  return path.resolve(__dirname, '../../../../server/tests/include/fixtures/projectA');
}

function projectB(): string {
  return path.resolve(__dirname, '../../../../server/tests/workspace/fixtures/projectB');
}

function targetUri(link: vscode.LocationLink | vscode.Location): vscode.Uri {
  return (link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri;
}

function targetRange(link: vscode.LocationLink | vscode.Location): vscode.Range {
  return (link as vscode.LocationLink).targetRange ?? (link as vscode.Location).range;
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  const within = !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return process.platform === 'win32'
    ? within || path.resolve(root).toLowerCase() === path.resolve(candidate).toLowerCase()
    : within;
}

async function makeMacroWorkspace(prefix: string, macroName: string, symbolName: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `usn-${prefix}-`));
  await fs.mkdir(path.join(root, 'Assets', 'Shaders'), { recursive: true });
  await fs.mkdir(path.join(root, 'ProjectSettings'), { recursive: true });
  await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');
  await fs.writeFile(
    path.join(root, 'Assets', 'Shaders', 'ScopedMacro.hlsl'),
    [
      `${macroName}(${symbolName});`,
      `float4 main() { return ${symbolName}.Sample(sampler${symbolName}, float2(0, 0)); }`,
    ].join('\n'),
  );
  return root;
}

async function waitForDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (links: Array<vscode.LocationLink | vscode.Location> | undefined) => boolean,
): Promise<Array<vscode.LocationLink | vscode.Location> | undefined> {
  const deadline = Date.now() + 6000;
  let latest: Array<vscode.LocationLink | vscode.Location> | undefined;
  while (Date.now() < deadline) {
    latest = await vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

suite('Multi-root isolation', () => {
  test('resource-scoped declarationMacros stay isolated per workspace folder', async () => {
    const aRoot = await makeMacroWorkspace('macro-a', 'A_TEX2D', '_ScopedTexA');
    const bRoot = await makeMacroWorkspace('macro-b', 'B_TEX2D', '_ScopedTexB');
    try {
      await withWorkspaceFolder(aRoot, async (aFolder) => {
        await withWorkspaceFolder(bRoot, async (bFolder) => {
          const aConfig = vscode.workspace.getConfiguration('unityShaderNav', aFolder.uri);
          const bConfig = vscode.workspace.getConfiguration('unityShaderNav', bFolder.uri);

          try {
            await aConfig.update(
              'declarationMacros',
              [{ pattern: 'A_TEX2D($name)', kind: 'variable' }],
              vscode.ConfigurationTarget.WorkspaceFolder,
            );
            await bConfig.update(
              'declarationMacros',
              [{ pattern: 'B_TEX2D($name)', kind: 'variable' }],
              vscode.ConfigurationTarget.WorkspaceFolder,
            );

            const aUri = vscode.Uri.file(path.join(aRoot, 'Assets', 'Shaders', 'ScopedMacro.hlsl'));
            const bUri = vscode.Uri.file(path.join(bRoot, 'Assets', 'Shaders', 'ScopedMacro.hlsl'));
            const aDoc = await vscode.workspace.openTextDocument(aUri);
            const bDoc = await vscode.workspace.openTextDocument(bUri);
            await vscode.window.showTextDocument(aDoc);
            await vscode.window.showTextDocument(bDoc);

            const aUsage = aDoc.lineAt(1).text.indexOf('_ScopedTexA');
            const bUsage = bDoc.lineAt(1).text.indexOf('_ScopedTexB');
            assert.ok(aUsage >= 0, 'expected _ScopedTexA usage');
            assert.ok(bUsage >= 0, 'expected _ScopedTexB usage');

            const aLinks = await waitForDefinitions(
              aUri,
              new vscode.Position(1, aUsage + 3),
              (links) => (links?.length ?? 0) >= 1 && targetRange(links![0]).start.line === 0,
            );
            const bLinks = await waitForDefinitions(
              bUri,
              new vscode.Position(1, bUsage + 3),
              (links) => (links?.length ?? 0) >= 1 && targetRange(links![0]).start.line === 0,
            );

            assert.ok(aLinks && aLinks.length >= 1, 'expected folder A macro declaration to resolve');
            assert.ok(bLinks && bLinks.length >= 1, 'expected folder B macro declaration to resolve');
            assert.ok(isWithinPath(aRoot, targetUri(aLinks[0]).fsPath), 'folder A definition should stay in folder A');
            assert.ok(isWithinPath(bRoot, targetUri(bLinks[0]).fsPath), 'folder B definition should stay in folder B');
          } finally {
            await aConfig.update('declarationMacros', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
            await bConfig.update('declarationMacros', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
          }
        });
      });
    } finally {
      await fs.rm(aRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await fs.rm(bRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('projectB resolves only projectB globals', async () => {
    const aRoot = projectA();
    const bRoot = projectB();
    await withWorkspaceFolder(aRoot, async () => {
      await withWorkspaceFolder(bRoot, async () => {
        const uri = vscode.Uri.file(path.join(bRoot, 'Assets/Shaders/BMain.shader'));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);

        const lines = doc.getText().split(/\r?\n/);
        const bLine = lines.findIndex((text) => text.includes('OnlyInB()') && text.includes('return'));
        assert.ok(bLine >= 0, 'expected OnlyInB() call in projectB fixture');
        const bCharacter = doc.lineAt(bLine).text.indexOf('OnlyInB()') + 2;
        const bLinks = await waitForDefinitions(
          uri,
          new vscode.Position(bLine, bCharacter),
          (links) => links?.length === 1,
        );

        assert.ok(bLinks && bLinks.length === 1, `expected one OnlyInB definition, got ${bLinks?.length}`);
        assert.ok(targetUri(bLinks[0]).fsPath.startsWith(bRoot), 'OnlyInB target should stay inside projectB');

        const commonLine = lines.findIndex((text) => text.includes('Common()'));
        assert.ok(commonLine >= 0, 'expected Common() probe in projectB fixture');
        const commonCharacter = doc.lineAt(commonLine).text.indexOf('Common()') + 2;
        const commonLinks = await waitForDefinitions(
          uri,
          new vscode.Position(commonLine, commonCharacter),
          (links) => (links?.length ?? 0) > 0,
        );

        assert.strictEqual(commonLinks?.length ?? 0, 0, 'projectA Common must not leak into projectB');
      });
    });
  });
});
