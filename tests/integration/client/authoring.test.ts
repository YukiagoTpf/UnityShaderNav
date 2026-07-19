import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures/authoring-assistance', ...segments);
}

async function completionItems(
  uri: vscode.Uri,
  position: vscode.Position,
  expected: string,
): Promise<vscode.CompletionItem[]> {
  return waitForEventually(
    `authoring completion ${expected}`,
    async () => (await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      position,
    ))?.items ?? [],
    (result) => result.some((item) => item.label === expected),
  );
}

suite('ShaderLab authoring assistance', () => {
  test('returns snippets only for their direct ShaderLab scopes', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('Assets', 'Snippets.shader'));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);
      const lines = document.getText().split(/\r?\n/);
      const atEnd = (needle: string) => {
        const line = lines.findIndex((value) => value.trim() === needle);
        assert.ok(line >= 0, `missing ${needle}`);
        return new vscode.Position(line, lines[line].length);
      };

      const property = (await completionItems(uri, atEnd('prop'), 'property-color'))
        .map((item) => String(item.label));
      assert.ok(property.includes('property-texture2d'));
      assert.ok(!property.includes('pass'));
      const pass = (await completionItems(uri, atEnd('pass'), 'pass'))
        .map((item) => String(item.label));
      assert.ok(!pass.includes('property-color'));
      assert.ok(pass.includes('vfpass'));
      const programItems = await completionItems(
        uri,
        atEnd('vertex'),
        'vertex-fragment-program',
      );
      assert.ok(!programItems.map((item) => String(item.label)).includes('pass'));
      assert.ok(programItems.some((item) => item.label === 'blend'));
      const protectedItems = (await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        atEnd('blendinside'),
      ))?.items ?? [];
      const protectedLabels = protectedItems.map((item) => String(item.label));
      assert.ok(!protectedLabels.some((label) => (
        label === 'surf'
        || label === 'vfshader'
        || label === 'vfpass'
        || label.startsWith('blend')
      )));
      const program = programItems.find((item) => item.label === 'vertex-fragment-program');
      assert.ok(program, 'expected program snippet completion item');
      const snippet = program.insertText instanceof vscode.SnippetString
        ? program.insertText.value
        : program.textEdit?.newText;
      assert.ok(snippet?.includes('#pragma fragment ${2:frag}'), 'expected serialized snippet body');
      const start = atEnd('vertex').translate(0, -'vertex'.length);
      const selection = new vscode.Selection(start, atEnd('vertex'));
      assert.strictEqual(
        await editor.insertSnippet(new vscode.SnippetString(snippet), selection),
        true,
      );
      assert.ok(document.getText().includes('#pragma vertex vert'));
      assert.ok(document.getText().includes('ENDHLSL'));
      assert.ok(!document.getText().includes('${'));

      const rootUri = vscode.Uri.file(fixturePath('Assets', 'RootSnippets.shader'));
      const rootDocument = await vscode.workspace.openTextDocument(rootUri);
      await vscode.window.showTextDocument(rootDocument);
      const rootPosition = new vscode.Position(0, 'surf'.length);
      const rootItems = await completionItems(rootUri, rootPosition, 'surf');
      assert.ok(rootItems.some((item) => item.label === 'vfshader'));
      const surface = rootItems.find((item) => item.label === 'surf');
      const surfaceBody = surface?.insertText instanceof vscode.SnippetString
        ? surface.insertText.value
        : surface?.textEdit?.newText;
      assert.ok(
        surfaceBody?.includes('#pragma surface ${2:surf} Standard'),
        'expected complete Surface Shader snippet body',
      );
    });
  });

  test('round-trips one normalized non-HDR Color tuple', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('Assets', 'ColorFormat.shader'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const colors = await waitForEventually(
        'ShaderLab document colors',
        async () => vscode.commands.executeCommand<vscode.ColorInformation[]>(
          'vscode.executeDocumentColorProvider',
          uri,
        ),
        (result) => result?.length === 1,
      );
      assert.strictEqual(colors.length, 1);
      assert.deepStrictEqual(colors[0].color, new vscode.Color(0.25, 0.5, 1, 0.75));

      const replacement = new vscode.Color(0.1, 0.2, 0.3, 1);
      const presentations = await vscode.commands.executeCommand<vscode.ColorPresentation[]>(
        'vscode.executeColorPresentationProvider',
        replacement,
        { uri, range: colors[0].range },
      );
      assert.ok(presentations?.length === 1, 'expected one ShaderLab tuple presentation');
      assert.ok(presentations[0].textEdit);
      assert.strictEqual(
        presentations[0].textEdit?.newText,
        '(0.1, 0.2, 0.3, 1)',
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, presentations[0].textEdit!.range, presentations[0].textEdit!.newText);
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
      const updated = await waitForEventually(
        'updated ShaderLab document color',
        async () => vscode.commands.executeCommand<vscode.ColorInformation[]>(
          'vscode.executeDocumentColorProvider',
          uri,
        ),
        (result) => result?.[0]?.color.red === 0.1,
      );
      assert.deepStrictEqual(updated[0].color, replacement);
    });
  });

  test('formats only safe ShaderLab indentation and preserves the entire HLSL block', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('Assets', 'ColorFormat.shader'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const original = document.getText();
      const edits = await waitForEventually(
        'ShaderLab formatting edits',
        async () => vscode.commands.executeCommand<vscode.TextEdit[]>(
          'vscode.executeFormatDocumentProvider',
          uri,
          { tabSize: 2, insertSpaces: true },
        ),
        (result) => (result?.length ?? 0) > 0,
      );
      const formatted = applyEdits(document, original, edits);
      assert.strictEqual(programBlock(formatted), programBlock(original));
      assert.ok(formatted.includes('    _Color'));

      const malformedUri = vscode.Uri.file(fixturePath('Assets', 'Malformed.shader'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(malformedUri));
      const refused = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        malformedUri,
        { tabSize: 2, insertSpaces: true },
      );
      assert.strictEqual(refused?.length ?? 0, 0);
    });
  });
});

function programBlock(text: string): string {
  const start = text.indexOf('HLSLPROGRAM');
  const end = text.indexOf('ENDHLSL', start);
  assert.ok(start >= 0 && end >= 0);
  return text.slice(start, end + 'ENDHLSL'.length);
}

function applyEdits(
  document: vscode.TextDocument,
  text: string,
  edits: readonly vscode.TextEdit[],
): string {
  let result = text;
  const ordered = [...edits].sort((left, right) => (
    document.offsetAt(right.range.start) - document.offsetAt(left.range.start)
  ));
  for (const edit of ordered) {
    const start = document.offsetAt(edit.range.start);
    const end = document.offsetAt(edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}
