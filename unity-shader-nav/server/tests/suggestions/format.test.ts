import { describe, expect, it } from 'vitest';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { signatureLabelOf, toCompletionItem } from '../../src/suggestions';

describe('suggestion formatting', () => {
  it('formats functions as LSP function completion items', () => {
    const item = toCompletionItem({
      name: 'Lighting',
      kind: 'function',
      source: 'project',
      returnType: 'float4',
      parameters: [{ name: 'normalWS', type: 'float3' }],
    });

    expect(item.label).toBe('Lighting');
    expect(item.kind).toBe(CompletionItemKind.Function);
    expect(item.detail).toBe('float4 Lighting(float3 normalWS)');
  });

  it('formats typed variables and symbol kinds', () => {
    expect(toCompletionItem({
      name: 'surface',
      kind: 'parameter',
      source: 'project',
      declaredType: 'Surface',
    })).toMatchObject({
      kind: CompletionItemKind.Variable,
      detail: 'Surface surface',
    });

    expect(toCompletionItem({
      name: 'positionWS',
      kind: 'structMember',
      source: 'project',
      declaredType: 'float3',
    })).toMatchObject({
      kind: CompletionItemKind.Field,
      detail: 'float3 positionWS',
    });
  });

  it('supports built-in-style parameters without source ranges', () => {
    expect(signatureLabelOf({
      name: 'SaturateLighting',
      kind: 'function',
      source: 'builtin',
      returnType: 'half3',
      parameters: [{ name: 'color', type: 'half3' }],
    })).toBe('half3 SaturateLighting(half3 color)');
  });

  it('preserves insert and sort text', () => {
    expect(toCompletionItem({
      name: 'helper',
      kind: 'function',
      source: 'project',
      insertText: 'helper',
      sortText: '1_helper',
    })).toMatchObject({
      insertText: 'helper',
      sortText: '1_helper',
    });
  });
});
