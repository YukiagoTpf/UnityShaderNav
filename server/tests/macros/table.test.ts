import { describe, expect, it, vi } from 'vitest';
import { MacroPatternTable } from '../../src/macros';

describe('MacroPatternTable', () => {
  it('skips malformed user declaration macros while preserving builtins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const table = new MacroPatternTable([
        { pattern: 'BROKEN $name', kind: 'variable' },
      ]);

      expect(table.findDecl('TEXTURE2D')).toHaveLength(1);
      expect(table.findDecl('BROKEN')).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid unityShaderNav.declarationMacros entry'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
