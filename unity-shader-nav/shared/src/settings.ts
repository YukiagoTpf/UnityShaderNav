export type DeclarationMacroKind = 'variable' | 'cbuffer';

export interface UserDeclarationMacro {
  /** Pattern source, e.g. "MY_TEX2D($name)" or "MY_CBUFFER($name)". */
  pattern: string;
  /** Symbol kind to register the captured $name as. */
  kind: DeclarationMacroKind;
}

export interface ExtensionSettings {
  projectRoot: string;
  includeDirectories: string[];
  excludePatterns: string[];
  declarationMacros: UserDeclarationMacro[];
  findReferences: { includePackages: boolean };
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  projectRoot: '',
  includeDirectories: [],
  excludePatterns: ['**/Library/**', '**/Temp/**', '**/Logs/**'],
  declarationMacros: [],
  findReferences: { includePackages: false },
};
