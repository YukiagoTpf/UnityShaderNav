import { describe, expect, it } from 'vitest';
import type { FunctionSymbolEntry, SymbolEntry } from '@unity-shader-nav/shared';
import type { BuiltinEntry } from '../../src/suggestions/builtins';
import {
  formatHoverCandidate,
  formatHoverCandidates,
  type BuiltinHoverInput,
  type ProjectHoverInput,
} from '../../src/hover/format';

function loc(uri: string, line = 0, character = 0) {
  return {
    uri,
    range: {
      start: { line, character },
      end: { line, character: character + 1 },
    },
  };
}

function projectInput(symbol: SymbolEntry, workspaceRootUri?: string): ProjectHoverInput {
  return { source: 'project', symbol, workspaceRootUri };
}

function builtinInput(entry: BuiltinEntry): BuiltinHoverInput {
  return { source: 'builtin', entry };
}

describe('formatHoverCandidate — project symbols', () => {
  it('formats a function with the same signature shape as signatureLabelOf', () => {
    const fn: FunctionSymbolEntry = {
      name: 'Lighting',
      kind: 'function',
      location: loc('file:///F:/proj/Lib.hlsl', 9),
      returnType: 'float4',
      parameters: [
        { name: 'normalWS', type: 'float3', range: loc('', 0, 0).range },
        { name: 'lightDir', type: 'float3', range: loc('', 0, 0).range },
      ],
    };

    const md = formatHoverCandidate(projectInput(fn, 'file:///F:/proj'));
    expect(md.kind).toBe('markdown');
    expect(md.value).toBe(
      '```hlsl\nfloat4 Lighting(float3 normalWS, float3 lightDir)\n```\n\n_in_ `Lib.hlsl`:10',
    );
  });

  it('formats a function with no parameters', () => {
    const fn: FunctionSymbolEntry = {
      name: 'Identity',
      kind: 'function',
      location: loc('file:///F:/proj/Lib.hlsl', 0),
      returnType: 'float',
      parameters: [],
    };

    const md = formatHoverCandidate(projectInput(fn, 'file:///F:/proj'));
    expect(md.value).toBe('```hlsl\nfloat Identity()\n```\n\n_in_ `Lib.hlsl`:1');
  });

  it('falls back returnType → declaredType → void for a function', () => {
    const fnNoReturn: FunctionSymbolEntry = {
      name: 'NoReturn',
      kind: 'function',
      // returnType is required by the type but the formatter must also
      // tolerate empty fallback chain via declaredType / 'void'.
      returnType: undefined as unknown as string,
      parameters: [],
      declaredType: 'half',
      location: loc('file:///F:/proj/Lib.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(fnNoReturn, 'file:///F:/proj'));
    expect(md.value).toContain('```hlsl\nhalf NoReturn()\n```');

    const fnVoid: FunctionSymbolEntry = {
      name: 'Anon',
      kind: 'function',
      returnType: undefined as unknown as string,
      parameters: [],
      location: loc('file:///F:/proj/Lib.hlsl', 0),
    };
    const md2 = formatHoverCandidate(projectInput(fnVoid, 'file:///F:/proj'));
    expect(md2.value).toContain('```hlsl\nvoid Anon()\n```');
  });

  it('formats a struct', () => {
    const s: SymbolEntry = {
      name: 'Surface',
      kind: 'struct',
      location: loc('file:///F:/proj/Lib.hlsl', 3),
    };
    const md = formatHoverCandidate(projectInput(s, 'file:///F:/proj'));
    expect(md.value).toBe('```hlsl\nstruct Surface\n```\n\n_in_ `Lib.hlsl`:4');
  });

  it('formats a struct member with parentType (member-of line + backticks)', () => {
    const m: SymbolEntry = {
      name: 'normalWS',
      kind: 'structMember',
      declaredType: 'float3',
      parentType: 'Surface',
      location: loc('file:///F:/proj/Lib.hlsl', 5),
    };
    const md = formatHoverCandidate(projectInput(m, 'file:///F:/proj'));
    expect(md.value).toBe(
      '```hlsl\nfloat3 normalWS;\n```\n\n_member of_ `Surface`\n\n_in_ `Lib.hlsl`:6',
    );
  });

  it('formats a struct member without parentType (omits the member-of line)', () => {
    const m: SymbolEntry = {
      name: 'orphan',
      kind: 'structMember',
      declaredType: 'float3',
      location: loc('file:///F:/proj/Lib.hlsl', 5),
    };
    const md = formatHoverCandidate(projectInput(m, 'file:///F:/proj'));
    expect(md.value).toBe('```hlsl\nfloat3 orphan;\n```\n\n_in_ `Lib.hlsl`:6');
    expect(md.value).not.toContain('_member of_');
  });

  it('falls back to unknown for a member with no declaredType', () => {
    const m: SymbolEntry = {
      name: 'x',
      kind: 'structMember',
      location: loc('file:///F:/proj/Lib.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(m, 'file:///F:/proj'));
    expect(md.value).toContain('```hlsl\nunknown x;\n```');
  });

  it('formats a variable', () => {
    const v: SymbolEntry = {
      name: '_Tint',
      kind: 'variable',
      declaredType: 'float4',
      location: loc('file:///F:/proj/Lib.hlsl', 12),
    };
    const md = formatHoverCandidate(projectInput(v, 'file:///F:/proj'));
    expect(md.value).toBe('```hlsl\nfloat4 _Tint;\n```\n\n_in_ `Lib.hlsl`:13');
  });

  it('formats a parameter (no trailing semicolon)', () => {
    const p: SymbolEntry = {
      name: 'normalWS',
      kind: 'parameter',
      declaredType: 'float3',
      location: loc('file:///F:/proj/Lib.hlsl', 9),
    };
    const md = formatHoverCandidate(projectInput(p, 'file:///F:/proj'));
    expect(md.value).toBe('```hlsl\nfloat3 normalWS\n```\n\n_in_ `Lib.hlsl`:10');
    expect(md.value).not.toContain('normalWS;');
  });

  it('formats a localVariable like a variable', () => {
    const lv: SymbolEntry = {
      name: 'tmp',
      kind: 'localVariable',
      declaredType: 'float',
      location: loc('file:///F:/proj/Lib.hlsl', 7),
    };
    const md = formatHoverCandidate(projectInput(lv, 'file:///F:/proj'));
    expect(md.value).toBe('```hlsl\nfloat tmp;\n```\n\n_in_ `Lib.hlsl`:8');
  });

  it('formats a macro', () => {
    const m: SymbolEntry = {
      name: 'MY_THING',
      kind: 'macro',
      location: loc('file:///F:/proj/Lib.hlsl', 2),
    };
    const md = formatHoverCandidate(projectInput(m, 'file:///F:/proj'));
    expect(md.value).toBe('```hlsl\n#define MY_THING\n```\n\n_in_ `Lib.hlsl`:3');
  });

  it('formats a cbuffer', () => {
    const c: SymbolEntry = {
      name: 'UnityPerMaterial',
      kind: 'cbuffer',
      location: loc('file:///F:/proj/Lib.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(c, 'file:///F:/proj'));
    expect(md.value).toBe('```hlsl\ncbuffer UnityPerMaterial\n```\n\n_in_ `Lib.hlsl`:1');
  });
});

describe('formatHoverCandidate — footer / path handling', () => {
  it('produces a relative path under workspaceRootUri', () => {
    const s: SymbolEntry = {
      name: 'Foo',
      kind: 'struct',
      location: loc('file:///F:/proj/sub/dir/A.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(s, 'file:///F:/proj'));
    expect(md.value).toContain('`sub/dir/A.hlsl`');
  });

  it('uses basename when workspaceRootUri does not prefix the path', () => {
    const s: SymbolEntry = {
      name: 'Foo',
      kind: 'struct',
      location: loc('file:///F:/other/A.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(s, 'file:///F:/proj'));
    expect(md.value).toContain('`A.hlsl`');
    expect(md.value).not.toContain('other');
  });

  it('uses basename when no workspaceRootUri is provided', () => {
    const s: SymbolEntry = {
      name: 'Foo',
      kind: 'struct',
      location: loc('file:///F:/some/dir/A.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(s));
    expect(md.value).toContain('`A.hlsl`');
    expect(md.value).not.toContain('dir');
  });

  it('decodes percent-encoded URIs via fileURLToPath (not raw decodeURIComponent)', () => {
    const s: SymbolEntry = {
      name: 'Foo',
      kind: 'struct',
      location: loc('file:///F:/Tab%20s.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(s));
    expect(md.value).toContain('`Tab s.hlsl`');
    expect(md.value).not.toContain('%20');
    expect(md.value).not.toContain('/F:/');
  });

  it('does not leave a leading slash on Windows drive-letter URIs', () => {
    const s: SymbolEntry = {
      name: 'Foo',
      kind: 'struct',
      location: loc('file:///F:/proj/A.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(s));
    // basename only — but the broader invariant is no `/F:` substring.
    expect(md.value).not.toMatch(/\/F:/);
  });
});

describe('formatHoverCandidate — built-in entries', () => {
  it('formats a built-in function with documentation and HLSL built-in label', () => {
    const entry: BuiltinEntry = {
      name: 'lerp',
      kind: 'function',
      category: 'hlsl',
      returnType: 'float',
      parameters: [
        { name: 'a', type: 'float' },
        { name: 'b', type: 'float' },
        { name: 't', type: 'float' },
      ],
      documentation: 'Linear interpolation between a and b.',
    };
    const md = formatHoverCandidate(builtinInput(entry));
    expect(md.kind).toBe('markdown');
    expect(md.value).toBe(
      '```hlsl\nfloat lerp(float a, float b, float t)\n```\n\nLinear interpolation between a and b.\n\n_HLSL built-in_',
    );
  });

  it('falls back to detail then name when no parameters', () => {
    const entry: BuiltinEntry = {
      name: 'POSITION',
      kind: 'semantic',
      category: 'semantic',
      detail: 'POSITION semantic',
      documentation: 'Vertex position input.',
    };
    const md = formatHoverCandidate(builtinInput(entry));
    expect(md.value).toBe(
      '```hlsl\nPOSITION semantic\n```\n\nVertex position input.\n\n_HLSL semantic_',
    );
  });

  it('uses entry.name when neither detail nor parameters are present', () => {
    const entry: BuiltinEntry = {
      name: 'Cull',
      kind: 'state',
      category: 'shaderlab',
    };
    const md = formatHoverCandidate(builtinInput(entry));
    expect(md.value).toBe('```hlsl\nCull\n```\n\n_ShaderLab built-in_');
  });

  it('renders the Unity built-in label', () => {
    const entry: BuiltinEntry = {
      name: 'UnityObjectToClipPos',
      kind: 'function',
      category: 'unitycg',
      returnType: 'float4',
      parameters: [{ name: 'pos', type: 'float3' }],
    };
    const md = formatHoverCandidate(builtinInput(entry));
    expect(md.value).toContain('_Unity built-in_');
  });

  it('renders the URP built-in label', () => {
    const entry: BuiltinEntry = {
      name: 'TransformObjectToHClip',
      kind: 'function',
      category: 'urp',
      returnType: 'float4',
      parameters: [{ name: 'pos', type: 'float3' }],
    };
    const md = formatHoverCandidate(builtinInput(entry));
    expect(md.value).toContain('_URP built-in_');
  });

  it('uses fenced detail (not param signature) for a function entry with no parameters array', () => {
    const entry: BuiltinEntry = {
      name: 'mad',
      kind: 'function',
      category: 'hlsl',
      detail: 'mad(a, b, c)',
    };
    const md = formatHoverCandidate(builtinInput(entry));
    expect(md.value).toContain('```hlsl\nmad(a, b, c)\n```');
    expect(md.value).toContain('_HLSL built-in_');
  });
});

describe('formatHoverCandidate — safe inline code escaping', () => {
  it('escapes a filename containing a backtick using a longer fence + padding spaces', () => {
    // file:///F:/proj/foo%60bar.hlsl decodes to F:/proj/foo`bar.hlsl
    // basename: foo`bar.hlsl (one ` → fence of two ` plus padding spaces).
    const s: SymbolEntry = {
      name: 'Foo',
      kind: 'struct',
      location: loc('file:///F:/proj/foo%60bar.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(s, 'file:///F:/proj'));
    expect(md.value).toContain('_in_ `` foo`bar.hlsl ``:1');
    // Sanity: it did NOT produce a broken single-backtick wrap.
    expect(md.value).not.toContain('`foo`bar.hlsl`');
  });

  it('escapes a structMember parentType containing a backtick', () => {
    const m: SymbolEntry = {
      name: 'x',
      kind: 'structMember',
      declaredType: 'float3',
      parentType: 'Weird`Type',
      location: loc('file:///F:/proj/Lib.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(m, 'file:///F:/proj'));
    expect(md.value).toContain('_member of_ `` Weird`Type ``');
  });

  it('replaces ASCII control characters in filenames with `?`', () => {
    // %07 is BEL (U+0007). Decoded filename: bell?ring.hlsl after sanitising.
    const s: SymbolEntry = {
      name: 'Foo',
      kind: 'struct',
      location: loc('file:///F:/proj/bell%07ring.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(s, 'file:///F:/proj'));
    expect(md.value).toContain('_in_ `bell?ring.hlsl`:1');
    // The raw BEL character must not survive into the rendered Markdown.
    expect(md.value).not.toMatch(/\x07/);
  });

  it('still uses a single-backtick wrap when no escaping is needed (regression)', () => {
    const s: SymbolEntry = {
      name: 'Foo',
      kind: 'struct',
      location: loc('file:///F:/proj/Lib.hlsl', 0),
    };
    const md = formatHoverCandidate(projectInput(s, 'file:///F:/proj'));
    expect(md.value).toContain('_in_ `Lib.hlsl`:1');
  });
});

describe('formatHoverCandidates', () => {
  const makeFn = (name: string, line: number): FunctionSymbolEntry => ({
    name,
    kind: 'function',
    location: loc('file:///F:/proj/Lib.hlsl', line),
    returnType: 'float',
    parameters: [],
  });

  it('returns an empty markdown value for zero inputs', () => {
    const md = formatHoverCandidates([]);
    expect(md.kind).toBe('markdown');
    expect(md.value).toBe('');
  });

  it('returns the single-candidate format identically for one input', () => {
    const fn = makeFn('Foo', 0);
    const single = formatHoverCandidate(projectInput(fn, 'file:///F:/proj'));
    const multi = formatHoverCandidates([projectInput(fn, 'file:///F:/proj')]);
    expect(multi).toEqual(single);
  });

  it('joins two candidates with a header and --- separator', () => {
    const a = projectInput(makeFn('Foo', 0), 'file:///F:/proj');
    const b = projectInput(makeFn('Foo', 5), 'file:///F:/proj');
    const md = formatHoverCandidates([a, b]);
    expect(md.value.startsWith('**2 candidates**\n\n')).toBe(true);
    expect(md.value).toContain('\n\n---\n\n');
    // Both candidate blocks present.
    expect(md.value).toContain('`Lib.hlsl`:1');
    expect(md.value).toContain('`Lib.hlsl`:6');
  });

  it('caps at maxCandidates and appends a truncation footer', () => {
    const inputs = Array.from({ length: 7 }, (_, i) =>
      projectInput(makeFn(`Foo${i}`, i), 'file:///F:/proj'),
    );
    const md = formatHoverCandidates(inputs, 5);
    expect(md.value.startsWith('**5 candidates**\n\n')).toBe(true);
    expect(md.value).toContain('\n\n_… and 2 more candidates_');
    // The 6th and 7th entries' synthesized source-lines should NOT appear.
    expect(md.value).toContain('`Lib.hlsl`:1');
    expect(md.value).toContain('`Lib.hlsl`:5');
    expect(md.value).not.toContain('`Lib.hlsl`:6');
    expect(md.value).not.toContain('`Lib.hlsl`:7');
  });

  it('defaults maxCandidates to 5 when omitted', () => {
    const inputs = Array.from({ length: 7 }, (_, i) =>
      projectInput(makeFn(`Foo${i}`, i), 'file:///F:/proj'),
    );
    const md = formatHoverCandidates(inputs);
    expect(md.value.startsWith('**5 candidates**\n\n')).toBe(true);
    expect(md.value).toContain('_… and 2 more candidates_');
  });

  it('does not append a truncation footer when count equals the cap', () => {
    const inputs = Array.from({ length: 5 }, (_, i) =>
      projectInput(makeFn(`Foo${i}`, i), 'file:///F:/proj'),
    );
    const md = formatHoverCandidates(inputs, 5);
    expect(md.value.startsWith('**5 candidates**\n\n')).toBe(true);
    expect(md.value).not.toContain('_… and');
  });
});
