import { describe, expect, it } from 'vitest';
import { MacroPatternRecognizer } from '../../src/macros';
import { indexFile } from '../../src/parser/hlsl';
import {
  SRP_BATCHER_LAYOUT_CODE,
  SRP_BATCHER_PROPERTY_CODE,
  SRP_BATCHER_TYPE_CODE,
  srpBatcherCodeActions,
  srpBatcherDiagnostics,
} from '../../src/workspace/materialContracts';

const uri = 'file:///project/Assets/Material.shader';

async function indexed(text: string) {
  return indexFile(uri, text, new MacroPatternRecognizer([]));
}

describe('SRP Batcher material contracts', () => {
  it('diagnoses a missing scalar field and offers a safe insertion', async () => {
    const text = [
      'Shader "Contracts/Missing" {',
      '  Properties {',
      '    _BaseColor ("Color", Color) = (1,1,1,1)',
      '    _Smoothness ("Smoothness", Range(0,1)) = 0.5',
      '    _MainTex ("Texture", 2D) = "white" {}',
      '  }',
      '  SubShader {',
      '    Tags { "RenderPipeline" = "UniversalPipeline" }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      CBUFFER_START(UnityPerMaterial)',
      '          float4 _BaseColor;',
      '      CBUFFER_END',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const index = await indexed(text);
    const diagnostics = srpBatcherDiagnostics(index);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: SRP_BATCHER_PROPERTY_CODE,
        range: index.properties?.[1].nameRange,
        message: expect.stringContaining('_Smoothness'),
      }),
    ]);
    const actions = srpBatcherCodeActions(
      index,
      uri,
      7,
      index.properties![1].nameRange,
      { diagnostics },
    );
    expect(actions).toEqual([
      expect.objectContaining({
        title: 'Add _Smoothness to UnityPerMaterial',
        isPreferred: true,
        edit: {
          documentChanges: [{
            textDocument: { uri, version: 7 },
            edits: [{
              range: {
                start: { line: 12, character: 0 },
                end: { line: 12, character: 0 },
              },
              newText: '          float _Smoothness;\n',
            }],
          }],
        },
      }),
    ]);
    expect(srpBatcherCodeActions(
      index,
      uri,
      7,
      index.properties![1].nameRange,
      { diagnostics, only: ['refactor'] },
    )).toEqual([]);
  });

  it('does not infer a missing cbuffer when an include may own the contract', async () => {
    const text = [
      'Shader "Contracts/Create" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  HLSLINCLUDE',
      '  #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
      '  ENDHLSL',
      '  SubShader { Pass {} Pass {} }',
      '}',
    ].join('\n');
    const index = await indexed(text);
    const diagnostics = srpBatcherDiagnostics(index);
    const actions = srpBatcherCodeActions(
      index,
      uri,
      1,
      index.properties![0].nameRange,
      { diagnostics },
    );

    expect(diagnostics).toEqual([]);
    expect(actions).toEqual([]);
  });

  it('refuses fixes for existing outside declarations and multiple Pass blocks', async () => {
    const outside = [
      'Shader "Contracts/Outside" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    float4 _Tint;',
      '    CBUFFER_START(UnityPerMaterial)',
      '    float4 _Other;',
      '    CBUFFER_END',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');
    const outsideIndex = await indexed(outside);
    const outsideDiagnostics = srpBatcherDiagnostics(outsideIndex);
    expect(outsideDiagnostics[0].message).toContain('declared outside');
    expect(srpBatcherCodeActions(
      outsideIndex,
      uri,
      1,
      outsideIndex.properties![0].nameRange,
      { diagnostics: outsideDiagnostics },
    )).toEqual([]);

    const multiple = [
      'Shader "Contracts/Multiple" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {',
      '    Tags { "RenderPipeline" = "UniversalPipeline" }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      ENDHLSL',
      '    }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const multipleIndex = await indexed(multiple);
    const multipleDiagnostics = srpBatcherDiagnostics(multipleIndex);
    expect(srpBatcherCodeActions(
      multipleIndex,
      uri,
      1,
      multipleIndex.properties![0].nameRange,
      { diagnostics: multipleDiagnostics },
    )).toEqual([]);

    const partialMultiPass = [
      'Shader "Contracts/Partial" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      CBUFFER_START(UnityPerMaterial)',
      '      CBUFFER_END',
      '      ENDHLSL',
      '    }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const partialIndex = await indexed(partialMultiPass);
    const partialDiagnostics = srpBatcherDiagnostics(partialIndex);
    expect(partialDiagnostics).toHaveLength(1);
    expect(srpBatcherCodeActions(
      partialIndex,
      uri,
      1,
      partialIndex.properties![0].nameRange,
      { diagnostics: partialDiagnostics },
    )).toEqual([]);
  });

  it('reports incompatible property types and deterministic cross-Pass layout drift', async () => {
    const text = [
      'Shader "Contracts/Layout" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      CBUFFER_START(UnityPerMaterial)',
      '      float _Tint;',
      '      float _Extra : packoffset(c1.x);',
      '      CBUFFER_END',
      '      ENDHLSL',
      '    }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      CBUFFER_START(UnityPerMaterial)',
      '      float4 _Tint;',
      '      float _Extra : packoffset(c2.x);',
      '      CBUFFER_END',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const diagnostics = srpBatcherDiagnostics(await indexed(text));

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      SRP_BATCHER_TYPE_CODE,
      SRP_BATCHER_LAYOUT_CODE,
    ]);
  });

  it('stays neutral without SRP evidence and for conditional layout comparisons', async () => {
    const legacy = [
      'Shader "Contracts/Legacy" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {}',
      '}',
    ].join('\n');
    expect(srpBatcherDiagnostics(await indexed(legacy))).toEqual([]);

    const conditional = [
      'Shader "Contracts/Conditional" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    CBUFFER_START(UnityPerMaterial)',
      '    #if USE_HALF',
      '    half4 _Tint;',
      '    #else',
      '    float4 _Tint;',
      '    #endif',
      '    CBUFFER_END',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');
    expect(srpBatcherDiagnostics(await indexed(conditional))).toEqual([]);
  });

  it('distinguishes legacy float-backed Int from Integer', async () => {
    const text = [
      'Shader "Contracts/Integers" {',
      '  Properties {',
      '    _Legacy ("Legacy", Int) = 1',
      '    _Count ("Count", Integer) = 1',
      '  }',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    CBUFFER_START(UnityPerMaterial)',
      '    float _Legacy;',
      '    int _Count;',
      '    CBUFFER_END',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');

    expect(srpBatcherDiagnostics(await indexed(text))).toEqual([]);
  });

  it('diagnoses a locally proven absent material block without inventing a fix', async () => {
    const text = [
      'Shader "Contracts/Absent" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {',
      '    Tags { "RenderPipeline" = "UniversalPipeline" }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const index = await indexed(text);
    const diagnostics = srpBatcherDiagnostics(index);

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: SRP_BATCHER_PROPERTY_CODE }),
    ]);
    expect(srpBatcherCodeActions(
      index,
      uri,
      1,
      index.properties![0].nameRange,
      { diagnostics },
    )).toEqual([]);
  });

  it('compares explicit packing and refuses to insert into a packed block', async () => {
    const drift = [
      'Shader "Contracts/Packing" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      cbuffer UnityPerMaterial {',
      '        float4 _Tint : packoffset(c0);',
      '      };',
      '      ENDHLSL',
      '    }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      cbuffer UnityPerMaterial {',
      '        float4 _Tint : packoffset(c1);',
      '      };',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(srpBatcherDiagnostics(await indexed(drift))).toEqual([
      expect.objectContaining({ code: SRP_BATCHER_LAYOUT_CODE }),
    ]);

    const insertion = [
      'Shader "Contracts/PackedInsertion" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '    _Smoothness ("Smoothness", Float) = 0.5',
      '  }',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    cbuffer UnityPerMaterial {',
      '      float4 _Tint : packoffset(c0);',
      '    };',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');
    const index = await indexed(insertion);
    const diagnostics = srpBatcherDiagnostics(index);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: SRP_BATCHER_PROPERTY_CODE }),
    ]);
    expect(srpBatcherCodeActions(
      index,
      uri,
      1,
      index.properties![1].nameRange,
      { diagnostics },
    )).toEqual([]);
  });

  it('stays neutral across SubShaders until pipeline ownership is modeled', async () => {
    const text = [
      'Shader "Contracts/MixedPipelines" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {',
      '    Tags { "RenderPipeline" = "UniversalPipeline" }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      CBUFFER_START(UnityPerMaterial)',
      '      float4 _Tint;',
      '      CBUFFER_END',
      '      ENDHLSL',
      '    }',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      CGPROGRAM',
      '      ENDCG',
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(srpBatcherDiagnostics(await indexed(text))).toEqual([]);
  });
});
