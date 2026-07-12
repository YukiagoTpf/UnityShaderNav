import { promises as fs } from 'node:fs';
import { join } from 'node:path';

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

  identity(): string {
    return this.editorVersion ?? 'unknown';
  }
}
