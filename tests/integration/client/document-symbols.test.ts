import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForDocumentSymbols(
  uri: vscode.Uri,
  predicate: (symbols: vscode.DocumentSymbol[] | undefined) => boolean,
): Promise<vscode.DocumentSymbol[] | undefined> {
  return waitForEventually(
    'document symbols',
    async () => vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    ),
    predicate,
    { timeoutMs: 5000, retryMs: 100 },
  );
}

function childNamed(
  symbols: readonly vscode.DocumentSymbol[] | undefined,
  name: string,
): vscode.DocumentSymbol | undefined {
  return symbols?.find((symbol) => symbol.name === name);
}

suite('Document Symbols', () => {
  test('outline contains function, struct children, cbuffer, and pragma in .hlsl', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const symbols = await waitForDocumentSymbols(uri, (result) =>
        !!childNamed(result, 'helper')
        && !!childNamed(result, 'Attributes')
        && !!childNamed(result, 'UnityPerMaterial')
        && !!childNamed(result, '#pragma main'),
      );

      assert.ok(symbols, 'document symbol provider returned no symbols');
      const attributes = childNamed(symbols, 'Attributes');
      assert.ok(
        childNamed(attributes?.children, 'positionOS'),
        'expected struct member under Attributes',
      );
    });
  });

  test('.shader outline shows Shader > Properties / SubShader > Pass > program > entry', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('multi-pass-test.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const symbols = await waitForDocumentSymbols(uri, (result) => {
        const shader = childNamed(result, 'Shader "Test/MultiPassDefn"');
        const subshader = childNamed(shader?.children, 'SubShader');
        const forward = childNamed(subshader?.children, 'Pass "ForwardLit"');
        const program = childNamed(forward?.children, 'HLSLPROGRAM');
        return !!childNamed(program?.children, 'vert');
      });

      const shader = childNamed(symbols, 'Shader "Test/MultiPassDefn"');
      assert.ok(shader, 'expected Shader root symbol');
      const properties = childNamed(shader.children, 'Properties');
      assert.ok(properties, 'expected Properties child');
      assert.ok(childNamed(properties.children, '_Tint'), 'expected property under Properties');
      const subshader = childNamed(shader.children, 'SubShader');
      assert.ok(subshader, 'expected SubShader child');
      const forward = childNamed(subshader.children, 'Pass "ForwardLit"');
      assert.ok(forward, 'expected ForwardLit pass child');
      const program = childNamed(forward.children, 'HLSLPROGRAM');
      assert.ok(program, 'expected HLSLPROGRAM under ForwardLit');
      assert.ok(childNamed(program.children, 'vert'), 'expected vert under HLSLPROGRAM');
    });
  });

  test('.shader outline ignores a valid Pass inside a multiline comment', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('multiline-comment-outline.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const symbols = await waitForDocumentSymbols(uri, (result) => {
        const shader = childNamed(result, 'Shader "Tests/MultilineCommentOutline"');
        const subshader = childNamed(shader?.children, 'SubShader');
        const realPass = childNamed(subshader?.children, 'Pass "RealPass"');
        const program = childNamed(realPass?.children, 'HLSLPROGRAM');
        return !!childNamed(program?.children, 'RealEntry');
      });

      const shader = childNamed(symbols, 'Shader "Tests/MultilineCommentOutline"');
      assert.ok(shader, 'expected Shader root symbol');
      const subshader = childNamed(shader.children, 'SubShader');
      assert.ok(subshader, 'expected SubShader child');
      assert.strictEqual(
        childNamed(subshader.children, 'Pass "FakeCommentedPass"'),
        undefined,
      );
      const passes = subshader.children.filter((symbol) => symbol.name.startsWith('Pass "'));
      assert.strictEqual(passes.length, 1);
      const realPass = childNamed(subshader.children, 'Pass "RealPass"');
      assert.ok(realPass, 'expected real Pass child');
      assert.deepStrictEqual(realPass.range.start, new vscode.Position(7, 0));
      assert.deepStrictEqual(realPass.range.end, new vscode.Position(12, 0));
      assert.deepStrictEqual(realPass.selectionRange.start, new vscode.Position(7, 0));
      const program = childNamed(realPass.children, 'HLSLPROGRAM');
      assert.ok(program, 'expected HLSLPROGRAM under real Pass');
      assert.ok(childNamed(program.children, 'RealEntry'), 'expected entry under HLSLPROGRAM');
    });
  });
});
