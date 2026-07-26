import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  IncludePointContext,
  IncludePointContextsResult,
} from '@unity-shader-nav/shared';
import {
  closeEditorsForFolder,
  getIndexStatus,
  indexStatusForFolder,
  waitForEventually,
  waitForIndexStatus,
  withWorkspaceFolder,
} from './helpers/workspace';

const PICK_CONTEXT_COMMAND = 'unityShaderNav.pickIncludePointContext';

const SHADER_TEXT = [
  'Shader "Context/ExtensionHost" {',
  '  HLSLINCLUDE',
  '  #define SHARED_SEED',
  '  ENDHLSL',
  '  SubShader {',
  '    Pass {',
  '      Name "Forward"',
  '      HLSLPROGRAM',
  '      #pragma vertex VertForward',
  '      #pragma fragment FragForward',
  '      #define FORWARD_PASS',
  '      #include "Nested.hlsl"',
  '      ENDHLSL',
  '    }',
  '    Pass {',
  '      Name "Unlit"',
  '      HLSLPROGRAM',
  '      #pragma fragment FragUnlit',
  '      #undef FORWARD_PASS',
  '      #include "Shared.hlsl"',
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
].join('\n');

const SHARED_TEXT = [
  '#ifdef FORWARD_PASS',
  'float4 BranchValue() { return 1; }',
  '#pragma vertex MissingForward',
  '#else',
  'float BranchValue() { return 0; }',
  '#endif',
  'void Use() { BranchValue(); }',
  'Bra',
].join('\n');

interface ContextCommandResult extends IncludePointContextsResult {
  readonly selection: IncludePointContext | null;
}

interface DecodedToken {
  readonly line: number;
  readonly typeIndex: number;
}

function decodeTokens(tokens: vscode.SemanticTokens): DecodedToken[] {
  const decoded: DecodedToken[] = [];
  let line = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    line += tokens.data[index];
    decoded.push({ line, typeIndex: tokens.data[index + 3] });
  }
  return decoded;
}

function functionLines(tokens: vscode.SemanticTokens): number[] {
  // Stable server legend: function = 4.
  return decodeTokens(tokens)
    .filter(({ typeIndex }) => typeIndex === 4)
    .map(({ line }) => line);
}

function targetLine(location: vscode.LocationLink | vscode.Location): number {
  return ((location as vscode.LocationLink).targetSelectionRange
    ?? (location as vscode.Location).range).start.line;
}

function contextDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((diagnostic) => (
    diagnostic.source === 'UnityShaderNav'
    && diagnostic.code === 'unresolved-entry-point'
  ));
}

async function currentRevision(root: string): Promise<number> {
  const status = indexStatusForFolder(await getIndexStatus(), root);
  assert.equal(status?.lifecycle.state, 'ready');
  assert.ok(status?.lifecycle.state === 'ready');
  return status.lifecycle.revision;
}

async function runContextCommand(
  argument: { readonly entryPoint?: string; readonly inspect?: true },
  predicate: (result: ContextCommandResult) => boolean,
): Promise<ContextCommandResult> {
  return waitForEventually(
    'Shader include-point Context command',
    () => vscode.commands.executeCommand<ContextCommandResult>(
      PICK_CONTEXT_COMMAND,
      argument,
    ),
    (result) => !!result && predicate(result),
    { timeoutMs: 8000, retryMs: 150 },
  );
}

async function semanticTokens(
  uri: vscode.Uri,
  predicate: (lines: number[]) => boolean,
): Promise<vscode.SemanticTokens> {
  return waitForEventually(
    `Context-aware semantic tokens for ${uri.fsPath}`,
    () => vscode.commands.executeCommand<vscode.SemanticTokens>(
      'vscode.provideDocumentSemanticTokens',
      uri,
    ),
    (tokens) => !!tokens && predicate(functionLines(tokens)),
    { timeoutMs: 8000, retryMs: 150 },
  );
}

suite('Shader include-point Context', () => {
  test('updates editor features and falls back across live edit and rebuild', async function() {
    this.timeout(45_000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usn-include-context-'));
    const shaders = path.join(root, 'Assets', 'Shaders');
    const shaderPath = path.join(shaders, 'Context.shader');
    const sharedPath = path.join(shaders, 'Shared.hlsl');
    const headPath = path.join(root, '.git', 'HEAD');
    await fs.mkdir(shaders, { recursive: true });
    await fs.mkdir(path.join(root, 'ProjectSettings'), { recursive: true });
    await fs.mkdir(path.join(root, 'Packages'), { recursive: true });
    await fs.mkdir(path.dirname(headPath), { recursive: true });
    await Promise.all([
      fs.writeFile(shaderPath, SHADER_TEXT),
      fs.writeFile(path.join(shaders, 'Nested.hlsl'), [
        '#define NESTED_PATH',
        '#include "Shared.hlsl"',
      ].join('\n')),
      fs.writeFile(sharedPath, SHARED_TEXT),
      fs.writeFile(
        path.join(root, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 2022.3.0f1\n',
      ),
      fs.writeFile(path.join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}\n'),
      fs.writeFile(headPath, 'ref: refs/heads/main\n'),
    ]);

    try {
      await withWorkspaceFolder(root, async () => {
        try {
          const sharedUri = vscode.Uri.file(sharedPath);
          const shared = await vscode.workspace.openTextDocument(sharedUri);
          await vscode.window.showTextDocument(shared, { preview: false });

          const forward = await runContextCommand(
            { entryPoint: 'FragForward' },
            (result) => result.selection?.entryPoint === 'FragForward',
          );
          assert.equal(forward.contexts.length, 3);
          assert.deepEqual(
            forward.contexts.map(({ passName, stage, chainDepth }) => ({
              passName,
              stage,
              chainDepth,
            })),
            [
              { passName: 'Forward', stage: 'fragment', chainDepth: 2 },
              { passName: 'Forward', stage: 'vertex', chainDepth: 2 },
              { passName: 'Unlit', stage: 'fragment', chainDepth: 1 },
            ],
          );
          assert.equal(forward.selection?.shaderName, 'Context/ExtensionHost');
          assert.equal(
            vscode.Uri.parse(forward.selection!.includeLocation.uri).fsPath,
            path.join(shaders, 'Nested.hlsl'),
          );

          await semanticTokens(sharedUri, (lines) => lines.includes(1) && !lines.includes(4));
          await waitForEventually(
            'Forward Context diagnostic',
            () => contextDiagnostics(sharedUri),
            (diagnostics) => diagnostics.length === 1,
          );

          const unlit = await runContextCommand(
            { entryPoint: 'FragUnlit' },
            (result) => result.selection?.entryPoint === 'FragUnlit',
          );
          assert.equal(unlit.selection?.passName, 'Unlit');
          await semanticTokens(sharedUri, (lines) => !lines.includes(1) && lines.includes(4));
          await waitForEventually(
            'Unlit Context diagnostics',
            () => contextDiagnostics(sharedUri),
            (diagnostics) => diagnostics.length === 0,
          );

          const completions = await waitForEventually(
            'Unlit Context completion ordering',
            () => vscode.commands.executeCommand<vscode.CompletionList>(
              'vscode.executeCompletionItemProvider',
              sharedUri,
              new vscode.Position(7, 3),
            ),
            (list) => list?.items.some((item) => (
              item.label === 'BranchValue' && item.detail === 'float BranchValue()'
            )) ?? false,
          );
          assert.ok(completions.items.some(({ label }) => label === 'BranchValue'));

          const definitions = await waitForEventually(
            'active Shader Context definition',
            () => vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
              'vscode.executeDefinitionProvider',
              sharedUri,
              new vscode.Position(6, 15),
            ),
            (locations) => locations?.length === 1,
          );
          // The selected Unlit Context proves the #else declaration active and
          // narrows away the inactive #ifdef declaration (issue #156).
          assert.deepEqual(definitions.map(targetLine), [4]);

          await runContextCommand(
            { entryPoint: 'FragForward' },
            (result) => result.selection?.entryPoint === 'FragForward',
          );
          const beforeLiveEdit = await currentRevision(root);
          const shaderUri = vscode.Uri.file(shaderPath);
          const shader = await vscode.workspace.openTextDocument(shaderUri);
          const shaderEditor = await vscode.window.showTextDocument(shader, { preview: false });
          const includeLine = shader.getText().split(/\r?\n/)
            .findIndex((line) => line.includes('#include "Nested.hlsl"'));
          assert.ok(includeLine >= 0);
          assert.ok(await shaderEditor.edit((builder) => {
            builder.delete(shader.lineAt(includeLine).rangeIncludingLineBreak);
          }));
          await waitForIndexStatus(
            'include-point live edit publication',
            (snapshot) => {
              const status = indexStatusForFolder(snapshot, root);
              return status?.lifecycle.state === 'ready'
                && status.lifecycle.revision > beforeLiveEdit;
            },
          );

          await vscode.window.showTextDocument(shared, { preview: false });
          const liveFallback = await runContextCommand(
            { inspect: true },
            (result) => result.contexts.length === 1 && result.selection === null,
          );
          assert.equal(liveFallback.contexts[0].entryPoint, 'FragUnlit');
          await semanticTokens(
            sharedUri,
            (lines) => lines.includes(1) && lines.includes(4),
          );

          const beforeRevert = await currentRevision(root);
          await vscode.window.showTextDocument(shader, { preview: false });
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
          await waitForIndexStatus(
            'disk Context restoration after closing live edit',
            (snapshot) => {
              const status = indexStatusForFolder(snapshot, root);
              return status?.lifecycle.state === 'ready'
                && status.lifecycle.revision > beforeRevert;
            },
          );
          await vscode.window.showTextDocument(shared, { preview: false });
          await runContextCommand(
            { entryPoint: 'FragForward' },
            (result) => result.selection?.entryPoint === 'FragForward',
          );

          const beforeRebuild = await currentRevision(root);
          await fs.writeFile(headPath, 'ref: refs/heads/context-rebuild\n');
          await waitForIndexStatus(
            'include-point Context rebuild publication',
            (snapshot) => {
              const status = indexStatusForFolder(snapshot, root);
              return status?.lifecycle.state === 'ready'
                && status.lifecycle.revision > beforeRebuild;
            },
          );
          const rebuildFallback = await runContextCommand(
            { inspect: true },
            (result) => result.contexts.length === 3 && result.selection === null,
          );
          assert.equal(
            rebuildFallback.contexts.some(({ entryPoint }) => entryPoint === 'FragForward'),
            true,
            'same source Context remains known but must not inherit the old publication selection',
          );
          await semanticTokens(
            sharedUri,
            (lines) => lines.includes(1) && lines.includes(4),
          );
        } finally {
          await closeEditorsForFolder(root);
        }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
