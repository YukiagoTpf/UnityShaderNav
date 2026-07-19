import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface UnityPredefinedShaderMacro {
  readonly name: 'UNITY_VERSION';
  readonly value: string;
  readonly editorVersion: string;
  readonly precision: 'documented' | 'majorMinor';
}

export class UnityProjectFacts {
  private constructor(readonly editorVersion: string | undefined) {}

  static unknown(): UnityProjectFacts {
    return new UnityProjectFacts(undefined);
  }

  static async load(unityRoot: string): Promise<UnityProjectFacts> {
    try {
      const text = await fs.readFile(
        join(unityRoot, 'ProjectSettings', 'ProjectVersion.txt'),
        'utf8',
      );
      return UnityProjectFacts.fromProjectVersionText(text);
    } catch {
      return UnityProjectFacts.unknown();
    }
  }

  static fromProjectVersionText(text: string): UnityProjectFacts {
    const match = /^m_EditorVersion:\s*(\d+\.\d+\.\d+[A-Za-z]\d+(?:[A-Za-z0-9.-]*)?)\s*$/m.exec(text);
    return new UnityProjectFacts(match?.[1]);
  }

  majorMinor(): string | undefined {
    const match = /^(\d+)\.(\d+)\./.exec(this.editorVersion ?? '');
    return match ? `${match[1]}.${match[2]}` : undefined;
  }

  predefinedShaderMacro(name: string): UnityPredefinedShaderMacro | undefined {
    if (name !== 'UNITY_VERSION' || !this.editorVersion) return undefined;
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(this.editorVersion);
    if (!version) return undefined;
    const major = Number(version[1]);
    const minor = Number(version[2]);
    const patch = Number(version[3]);
    if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;

    // Unity 2023 and earlier document YYYYMP, with one digit each for M/P.
    if (major <= 2023 && minor <= 9 && patch <= 9) {
      return {
        name,
        value: `${major}${minor}${patch}`,
        editorVersion: this.editorVersion,
        precision: 'documented',
      };
    }
    // Unity 6.0 documents 6000PPPP, with a four-digit patch field.
    if (major === 6000 && minor === 0 && patch <= 9999) {
      return {
        name,
        value: `${major}${String(patch).padStart(4, '0')}`,
        editorVersion: this.editorVersion,
        precision: 'documented',
      };
    }

    // Older LTS patch numbers commonly exceed the single documented P digit.
    // Preserve a useful, unambiguous major/minor prefix without inventing an
    // exact compiler value for a version shape the documented format cannot encode.
    return {
      name,
      value: `${major}${minor}`,
      editorVersion: this.editorVersion,
      precision: 'majorMinor',
    };
  }

  identity(): string {
    return this.editorVersion ?? 'unknown';
  }
}
