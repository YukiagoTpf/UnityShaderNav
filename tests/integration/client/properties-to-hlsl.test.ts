import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (links: Array<vscode.LocationLink | vscode.Location> | undefined) => boolean,
  timeoutMs = 5000,
): Promise<Array<vscode.LocationLink | vscode.Location> | undefined> {
  const deadline = Date.now() + timeoutMs;
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

function targetRange(link: vscode.LocationLink | vscode.Location): vscode.Range {
  return (link as vscode.LocationLink).targetRange ?? (link as vscode.Location).range;
}

function targetUri(link: vscode.LocationLink | vscode.Location): vscode.Uri {
  return (link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri;
}

function targetSelectionRange(link: vscode.LocationLink | vscode.Location): vscode.Range {
  return (link as vscode.LocationLink).targetSelectionRange ?? targetRange(link);
}

function findLineIndex(doc: vscode.TextDocument, needle: string): number {
  const lines = doc.getText().split(/\r?\n/);
  return lines.findIndex((line) => line.includes(needle));
}

suite('F12 Properties <-> HLSL', () => {
  test('forward inline: property _MainTex jumps to TEXTURE2D declaration', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('properties-inline-hlsl.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const propLine = findLineIndex(doc, '_MainTex ("Base Map", 2D)');
      assert.ok(propLine >= 0, 'expected _MainTex property line in fixture');
      const propCol = doc.lineAt(propLine).text.indexOf('_MainTex') + 2;
      const hlslLine = findLineIndex(doc, 'TEXTURE2D(_MainTex)');
      assert.ok(hlslLine >= 0, 'expected TEXTURE2D(_MainTex) line in fixture');

      const links = await waitForDefinitions(
        uri,
        new vscode.Position(propLine, propCol),
        (result) =>
          !!result &&
          result.some((link) => targetRange(link).start.line === hlslLine),
      );

      assert.ok(links && links.length >= 1, 'expected at least one definition link');
      const hit = links.find((link) => targetRange(link).start.line === hlslLine);
      assert.ok(hit, `expected a link landing on line ${hlslLine} (TEXTURE2D)`);
    });
  });

  test('forward inline: property _BaseColor jumps to float4 declaration', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('properties-inline-hlsl.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const propLine = findLineIndex(doc, '_BaseColor ("Tint", Color)');
      assert.ok(propLine >= 0, 'expected _BaseColor property line in fixture');
      const propCol = doc.lineAt(propLine).text.indexOf('_BaseColor') + 2;
      const hlslLine = findLineIndex(doc, 'float4 _BaseColor;');
      assert.ok(hlslLine >= 0, 'expected float4 _BaseColor; line in fixture');

      const links = await waitForDefinitions(
        uri,
        new vscode.Position(propLine, propCol),
        (result) =>
          !!result &&
          result.some((link) => targetRange(link).start.line === hlslLine),
      );

      assert.ok(links && links.length >= 1, 'expected at least one definition link');
      const hit = links.find((link) => targetRange(link).start.line === hlslLine);
      assert.ok(hit, `expected a link landing on line ${hlslLine} (float4 _BaseColor)`);
    });
  });

  test('forward via include: property _MainTex jumps into Lib.hlsl', async () => {
    const folder = fixturePath('properties-include');
    await withWorkspaceFolder(folder, async () => {
      // Warm the include target so it is in the index store regardless of
      // workspace-scan timing.
      const libUri = vscode.Uri.file(path.join(folder, 'Lib.hlsl'));
      const libDoc = await vscode.workspace.openTextDocument(libUri);
      await vscode.window.showTextDocument(libDoc);

      const uri = vscode.Uri.file(path.join(folder, 'Inline.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const propLine = findLineIndex(doc, '_MainTex ("Base Map", 2D)');
      assert.ok(propLine >= 0, 'expected _MainTex property line in fixture');
      const propCol = doc.lineAt(propLine).text.indexOf('_MainTex') + 2;

      const links = await waitForDefinitions(
        uri,
        new vscode.Position(propLine, propCol),
        (result) =>
          !!result &&
          result.some((link) => targetUri(link).fsPath.toLowerCase().endsWith('lib.hlsl')),
        10000,
      );

      assert.ok(links && links.length >= 1, 'expected at least one definition link');
      const hit = links.find((link) => targetUri(link).fsPath.toLowerCase().endsWith('lib.hlsl'));
      assert.ok(hit, 'expected a link whose target URI ends with Lib.hlsl');
    });
  });

  test('reverse inline: HLSL _MainTex surfaces both HLSL decl and property entry', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('properties-inline-hlsl.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const propLine = findLineIndex(doc, '_MainTex ("Base Map", 2D)');
      assert.ok(propLine >= 0, 'expected _MainTex property line');
      const hlslLine = findLineIndex(doc, 'TEXTURE2D(_MainTex)');
      assert.ok(hlslLine >= 0, 'expected TEXTURE2D(_MainTex) line');
      const hlslCol = doc.lineAt(hlslLine).text.indexOf('_MainTex') + 2;

      const links = await waitForDefinitions(
        uri,
        new vscode.Position(hlslLine, hlslCol),
        (result) => (result?.length ?? 0) >= 2,
      );

      assert.ok(links && links.length >= 2, `expected >= 2 links, got ${links?.length ?? 0}`);

      const shaderFsPath = uri.fsPath.toLowerCase();
      const sameShaderLinks = links.filter(
        (link) => targetUri(link).fsPath.toLowerCase() === shaderFsPath,
      );
      assert.ok(
        sameShaderLinks.length >= 2,
        'expected at least two links pointing back into the same .shader fixture',
      );

      const propertyHit = sameShaderLinks.find(
        (link) => targetSelectionRange(link).start.line === propLine,
      );
      assert.ok(propertyHit, `expected at least one link whose selection range is on the property line (${propLine})`);
    });
  });

  test('no match: property _DoesNotExist returns no definition link', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('properties-inline-hlsl-extra.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      // Warm the index by first resolving a known-good property in the same file.
      const warmLine = findLineIndex(doc, '_MainTex ("Base Map", 2D)');
      assert.ok(warmLine >= 0, 'expected _MainTex property line');
      const warmCol = doc.lineAt(warmLine).text.indexOf('_MainTex') + 2;
      await waitForDefinitions(
        uri,
        new vscode.Position(warmLine, warmCol),
        (result) => (result?.length ?? 0) >= 1,
      );

      const missingLine = findLineIndex(doc, '_DoesNotExist');
      assert.ok(missingLine >= 0, 'expected _DoesNotExist property line in fixture');
      const missingCol = doc.lineAt(missingLine).text.indexOf('_DoesNotExist') + 2;

      const links = await vscode.commands.executeCommand<
        Array<vscode.LocationLink | vscode.Location> | undefined
      >('vscode.executeDefinitionProvider', uri, new vscode.Position(missingLine, missingCol));

      const count = links?.length ?? 0;
      assert.strictEqual(count, 0, `expected no links for _DoesNotExist, got ${count}`);
    });
  });
});
