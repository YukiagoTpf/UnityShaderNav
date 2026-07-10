import { describe, expect, it } from 'vitest';
import { analyzeCursor } from '../../../src/parser/lexical/cursor';

type ExpectedSlice = {
  word?: string | null;
  memberMember?: string | null;
  memberReceiver?: string | null;
  lexical?: 'code' | 'comment' | 'string';
  classification?:
    | 'hlslCode'
    | 'shaderLabCode'
    | 'semanticPosition'
    | 'shaderLabStateValue'
    | 'comment'
    | 'string';
  prefix?: string;
  memberPrefixReceiver?: string | null;
};

interface Case {
  name: string;
  text: string;
  line: number;
  character: number;
  languageId: string;
  uri: string;
  expect: ExpectedSlice;
}

const HLSL = 'file:///t/test.hlsl';
const SHADER = 'file:///t/test.shader';

// A realistic small ShaderLab doc with an HLSLPROGRAM...ENDHLSL block, used by the
// block-gating cases (#10). Property names live in the ShaderLab region; code inside
// the HLSLPROGRAM block is HLSL.
const SHADER_DOC = [
  'Shader "T/Test" {',                            // 0
  '  Properties { _Color ("Color", Float) = 1 }', // 1
  '  SubShader { Pass {',                          // 2
  '    HLSLPROGRAM',                               // 3
  '    float4 myFunc() { return 0; }',             // 4
  '    ENDHLSL',                                    // 5
  '  } }',                                          // 6
  '}',                                              // 7
].join('\n');

const cases: Case[] = [
  // 1. plain identifier in HLSL
  {
    name: 'plain identifier in HLSL',
    text: 'float myVar = 0.0;',
    line: 0,
    character: 'float my'.length, // inside myVar
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: 'myVar',
      memberMember: 'myVar',
      memberReceiver: null,
      lexical: 'code',
      classification: 'hlslCode',
      prefix: 'my',
      memberPrefixReceiver: null,
    },
  },

  // 2. member access with nested bracket receiver
  {
    name: 'member access with nested bracket receiver lights[i].color',
    text: 'float3 c = lights[i].color;',
    line: 0,
    character: 'float3 c = lights[i].co'.length, // inside color
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: 'color',
      memberMember: 'color',
      memberReceiver: 'lights[i]',
      lexical: 'code',
      classification: 'hlslCode',
      prefix: 'co',
      // memberPrefix mirrors the completion member context; here the receiver is the
      // bracketed expression and the (partial) member prefix is 'co'.
      memberPrefixReceiver: 'lights[i]',
    },
  },

  // 3. member completion right after a dot (memberPrefix)
  {
    name: 'member completion right after a dot',
    text: 'float3 c = surface.',
    line: 0,
    character: 'float3 c = surface.'.length, // immediately after the dot
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: null, // off any identifier (cursor sits right after '.')
      memberMember: null,
      memberReceiver: null,
      lexical: 'code',
      classification: 'hlslCode',
      prefix: '',
      memberPrefixReceiver: 'surface',
    },
  },

  // 4. include path: cursor on the filename inside #include "Common.hlsl"
  // CURRENT behavior: the path text is inside a string literal, so the cursor's
  // lexical state and classification are both 'string'. wordAt still finds the bare
  // identifier ('Common') under the cursor.
  // #30 will add an include-path classification; until then this is just a string.
  {
    name: 'include path filename (currently classified as string)',
    text: '#include "Common.hlsl"',
    line: 0,
    character: '#include "Co'.length, // inside the Common token
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: 'Common',
      memberMember: 'Common',
      memberReceiver: null,
      lexical: 'string',
      classification: 'string', // #30 will add an include-path classification
      prefix: 'Co',
      memberPrefixReceiver: null,
    },
  },

  // 5. semantic position: float4 c : SV_Target
  {
    name: 'semantic position after a colon',
    text: 'struct V { float4 c : SV_Target; };',
    line: 0,
    character: 'struct V { float4 c : SV_'.length, // inside SV_Target
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: 'SV_Target',
      memberMember: 'SV_Target',
      memberReceiver: null,
      lexical: 'code',
      classification: 'semanticPosition',
      prefix: 'SV_',
      memberPrefixReceiver: null,
    },
  },

  // 6. ShaderLab state value: cursor in the value slot of `Blend One`
  {
    name: 'ShaderLab state value (Blend One)',
    text: 'Shader "T" {\n  SubShader { Pass {\n    Blend One\n  } }\n}',
    line: 2,
    character: '    Blend O'.length, // inside One
    languageId: 'shaderlab',
    uri: SHADER,
    expect: {
      word: 'One',
      memberMember: 'One',
      memberReceiver: null,
      lexical: 'code',
      classification: 'shaderLabStateValue',
      prefix: 'O',
      memberPrefixReceiver: null,
    },
  },

  // 7. line comment
  {
    name: 'inside a line comment',
    text: 'float a = 1; // helper note',
    line: 0,
    character: 'float a = 1; // he'.length, // inside helper
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: 'helper',
      lexical: 'comment',
      classification: 'comment',
      prefix: 'he',
      memberPrefixReceiver: null,
    },
  },

  // 7b. block comment
  {
    name: 'inside a block comment',
    text: '/*\n block helper\n*/',
    line: 1,
    character: 4, // inside block
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: 'block',
      lexical: 'comment',
      classification: 'comment',
      prefix: 'blo',
      memberPrefixReceiver: null,
    },
  },

  // 8. string literal
  {
    name: 'inside a string literal',
    text: 'float4 main() { return "helper"; }',
    line: 0,
    character: 'float4 main() { return "he'.length, // inside helper
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: 'helper',
      lexical: 'string',
      classification: 'string',
      prefix: 'he',
      memberPrefixReceiver: null,
    },
  },

  // 9. generic type argument: cursor on MyType in StructuredBuffer<MyType>
  // CURRENT behavior: this is ordinary HLSL code; there is no generic-type-arg
  // classification yet. #30 will add one. wordAt resolves the type-arg identifier.
  {
    name: 'generic type argument (currently classified as hlslCode)',
    text: 'StructuredBuffer<MyType> buf;',
    line: 0,
    character: 'StructuredBuffer<My'.length, // inside MyType
    languageId: 'hlsl',
    uri: HLSL,
    expect: {
      word: 'MyType',
      memberMember: 'MyType',
      memberReceiver: null,
      lexical: 'code',
      classification: 'hlslCode', // #30 will add a generic-type-arg classification
      prefix: 'My',
      memberPrefixReceiver: null,
    },
  },

  // 10a. ShaderLab-vs-HLSL gating: identical-looking code OUTSIDE the HLSLPROGRAM block
  {
    name: 'ShaderLab doc, code OUTSIDE an HLSLPROGRAM block',
    text: SHADER_DOC,
    line: 1,
    character: SHADER_DOC.split('\n')[1].indexOf('_Color') + 2, // inside _Color
    languageId: 'shaderlab',
    uri: SHADER,
    expect: {
      word: '_Color',
      lexical: 'code',
      classification: 'shaderLabCode',
      prefix: '_C',
      memberPrefixReceiver: null,
    },
  },

  // 10b. ShaderLab-vs-HLSL gating: code INSIDE the HLSLPROGRAM block
  {
    name: 'ShaderLab doc, code INSIDE an HLSLPROGRAM block',
    text: SHADER_DOC,
    line: 4,
    character: SHADER_DOC.split('\n')[4].indexOf('myFunc') + 2, // inside myFunc
    languageId: 'shaderlab',
    uri: SHADER,
    expect: {
      word: 'myFunc',
      lexical: 'code',
      classification: 'hlslCode',
      prefix: 'my',
      memberPrefixReceiver: null,
    },
  },
];

describe('analyzeCursor', () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = analyzeCursor(c.text, { line: c.line, character: c.character }, c.languageId, c.uri);

      if ('word' in c.expect) {
        expect(result.word?.text ?? null).toBe(c.expect.word);
      }
      if ('memberMember' in c.expect) {
        expect(result.member?.member.text ?? null).toBe(c.expect.memberMember);
      }
      if ('memberReceiver' in c.expect) {
        expect(result.member?.receiver?.text ?? null).toBe(c.expect.memberReceiver);
      }
      if ('lexical' in c.expect) {
        expect(result.lexical).toBe(c.expect.lexical);
      }
      if ('classification' in c.expect) {
        expect(result.classification).toBe(c.expect.classification);
      }
      if ('prefix' in c.expect) {
        expect(result.prefix.text).toBe(c.expect.prefix);
      }
      if ('memberPrefixReceiver' in c.expect) {
        expect(result.memberPrefix?.receiver ?? null).toBe(c.expect.memberPrefixReceiver);
      }
    });
  }
});
