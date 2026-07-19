import { describe, expect, it } from 'vitest';
import { UnityProjectFacts } from '../../src/project';

describe('UnityProjectFacts predefined shader macros', () => {
  it('uses Unity documented version encodings when the fields are representable', () => {
    expect(UnityProjectFacts.fromProjectVersionText(
      'm_EditorVersion: 2022.3.0f1\n',
    ).predefinedShaderMacro('UNITY_VERSION')).toEqual({
      name: 'UNITY_VERSION',
      value: '202230',
      editorVersion: '2022.3.0f1',
      precision: 'documented',
    });
    expect(UnityProjectFacts.fromProjectVersionText(
      'm_EditorVersion: 6000.0.42f1\n',
    ).predefinedShaderMacro('UNITY_VERSION')).toEqual({
      name: 'UNITY_VERSION',
      value: '60000042',
      editorVersion: '6000.0.42f1',
      precision: 'documented',
    });
  });

  it('uses a transparent major/minor prefix when legacy patch fields exceed one digit', () => {
    expect(UnityProjectFacts.fromProjectVersionText(
      'm_EditorVersion: 2022.3.53f1\n',
    ).predefinedShaderMacro('UNITY_VERSION')).toEqual({
      name: 'UNITY_VERSION',
      value: '20223',
      editorVersion: '2022.3.53f1',
      precision: 'majorMinor',
    });
  });

  it('stays neutral for unknown projects and unrelated macros', () => {
    expect(UnityProjectFacts.unknown().predefinedShaderMacro('UNITY_VERSION')).toBeUndefined();
    expect(UnityProjectFacts.fromProjectVersionText(
      'm_EditorVersion: 2022.3.0f1\n',
    ).predefinedShaderMacro('UNITY_PASS_FORWARDBASE')).toBeUndefined();
    expect(UnityProjectFacts.fromProjectVersionText(
      `m_EditorVersion: ${'9'.repeat(400)}.3.0f1\n`,
    ).predefinedShaderMacro('UNITY_VERSION')).toBeUndefined();
  });
});
