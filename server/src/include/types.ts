import type { ExtensionSettings } from '@unity-shader-nav/shared';

export interface IncludeContext {
  /** Absolute path; undefined means standalone mode. */
  unityProjectRoot: string | undefined;
  includeDirectories: string[];
  /** Optional physical package map resolved from Packages/packages-lock.json. */
  packagePhysicalPaths?: Map<string, string>;
}

export interface ResolvedInclude {
  absolutePath: string;
  via: 'relative' | 'assets' | 'package' | 'includeDirectories' | 'caseInsensitiveFallback';
  caseInsensitive: boolean;
}

export function buildContext(
  settings: ExtensionSettings,
  autoDetectedRoot: string | undefined,
): IncludeContext {
  return {
    unityProjectRoot: settings.projectRoot || autoDetectedRoot,
    includeDirectories: settings.includeDirectories,
  };
}
