import type { UserDeclarationMacro } from '@unity-shader-nav/shared';
import {
  BUILTIN_DECLARATION_MACROS,
  BUILTIN_REFERENCE_MACROS,
  BUILTIN_SENTINEL_MACROS,
} from './builtin';
import { parsePattern, type CompiledPattern } from './patterns';

export interface CompiledDeclaration {
  pattern: CompiledPattern;
  symbolKind: 'variable' | 'cbuffer';
}

export interface CompiledReference {
  pattern: CompiledPattern;
}

export class MacroPatternTable {
  private readonly declByHead = new Map<string, CompiledDeclaration[]>();
  private readonly refByHead = new Map<string, CompiledReference[]>();
  private readonly sentinelHeads = new Set<string>();

  constructor(userMacros: UserDeclarationMacro[] = []) {
    for (const m of BUILTIN_DECLARATION_MACROS) {
      if (m.kind === 'function-reference') continue;
      this.addDecl(m.pattern, m.kind);
    }
    for (const m of BUILTIN_REFERENCE_MACROS) {
      this.addRef(m.pattern);
    }
    for (const m of BUILTIN_SENTINEL_MACROS) {
      this.sentinelHeads.add(m);
    }
    for (const u of userMacros) {
      this.addUserDecl(u.pattern, u.kind);
    }
  }

  private addDecl(pattern: string, kind: 'variable' | 'cbuffer'): void {
    const compiled = parsePattern(pattern);
    const arr = this.declByHead.get(compiled.head) ?? [];
    arr.push({ pattern: compiled, symbolKind: kind });
    this.declByHead.set(compiled.head, arr);
  }

  private addRef(pattern: string): void {
    const compiled = parsePattern(pattern);
    const arr = this.refByHead.get(compiled.head) ?? [];
    arr.push({ pattern: compiled });
    this.refByHead.set(compiled.head, arr);
  }

  private addUserDecl(pattern: string, kind: 'variable' | 'cbuffer'): void {
    try {
      this.addDecl(pattern, kind);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `Skipping invalid unityShaderNav.declarationMacros entry "${pattern}": ${reason}`,
      );
    }
  }

  findDecl(head: string): CompiledDeclaration[] {
    return this.declByHead.get(head) ?? [];
  }

  findRef(head: string): CompiledReference[] {
    return this.refByHead.get(head) ?? [];
  }

  isSentinel(head: string): boolean {
    return this.sentinelHeads.has(head);
  }
}
