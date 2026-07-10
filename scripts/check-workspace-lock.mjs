import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), '..');

export function validateWorkspaceLock(rootPackage, workspacePackages, lockfile) {
  const errors = [];
  const workspacePaths = declaredWorkspacePaths(rootPackage, errors);
  const lockPackages = lockfile?.packages;

  if (!lockPackages || typeof lockPackages !== 'object' || Array.isArray(lockPackages)) {
    errors.push('package-lock.json#packages must be an object');
  } else {
    expectEqual(
      errors,
      'package-lock.json#packages[""].workspaces',
      lockPackages['']?.workspaces,
      workspacePaths,
      'package.json#workspaces',
    );
  }

  for (const workspacePath of workspacePaths) {
    const manifest = workspacePackages.get(workspacePath);
    const manifestPath = `${workspacePath}/package.json`;
    if (!manifest) {
      errors.push(`${manifestPath} was not provided for declared workspace ${JSON.stringify(workspacePath)}`);
      continue;
    }

    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      errors.push(`${manifestPath}#name must be a non-empty string`);
      continue;
    }
    if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
      errors.push(`${manifestPath}#version must be a non-empty string`);
      continue;
    }

    const workspaceEntryPath = `package-lock.json#packages[${JSON.stringify(workspacePath)}]`;
    const workspaceEntry = lockPackages?.[workspacePath];
    if (!workspaceEntry) {
      errors.push(`${workspaceEntryPath} is missing for ${manifestPath}`);
    } else {
      expectEqual(errors, `${workspaceEntryPath}.name`, workspaceEntry.name, manifest.name, `${manifestPath}#name`);
      expectEqual(errors, `${workspaceEntryPath}.version`, workspaceEntry.version, manifest.version, `${manifestPath}#version`);
    }

    const linkPath = `node_modules/${manifest.name}`;
    const linkEntryPath = `package-lock.json#packages[${JSON.stringify(linkPath)}]`;
    const linkEntry = lockPackages?.[linkPath];
    if (!linkEntry) {
      errors.push(`${linkEntryPath} is missing for workspace ${JSON.stringify(workspacePath)}`);
    } else {
      expectEqual(errors, `${linkEntryPath}.link`, linkEntry.link, true, 'workspace link contract');
      expectEqual(errors, `${linkEntryPath}.resolved`, linkEntry.resolved, workspacePath, 'package.json#workspaces');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Workspace lock contract failed:\n- ${errors.join('\n- ')}`);
  }

  return workspacePaths.length;
}

export async function checkWorkspaceLock(repositoryRoot = defaultRepositoryRoot) {
  const rootPackage = await readJson(resolve(repositoryRoot, 'package.json'));
  const preliminaryErrors = [];
  const workspacePaths = declaredWorkspacePaths(rootPackage, preliminaryErrors);
  if (preliminaryErrors.length > 0) {
    throw new Error(`Workspace lock contract failed:\n- ${preliminaryErrors.join('\n- ')}`);
  }

  const workspacePackages = new Map(await Promise.all(workspacePaths.map(async (workspacePath) => [
    workspacePath,
    await readJson(resolve(repositoryRoot, workspacePath, 'package.json')),
  ])));
  const lockfile = await readJson(resolve(repositoryRoot, 'package-lock.json'));
  return validateWorkspaceLock(rootPackage, workspacePackages, lockfile);
}

function declaredWorkspacePaths(rootPackage, errors) {
  if (!Array.isArray(rootPackage?.workspaces)
      || rootPackage.workspaces.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    errors.push('package.json#workspaces must be an array of non-empty relative paths');
    return [];
  }
  return rootPackage.workspaces;
}

function expectEqual(errors, targetPath, actual, expected, sourcePath) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`${targetPath} expected ${JSON.stringify(expected)} from ${sourcePath}; received ${JSON.stringify(actual)}`);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  checkWorkspaceLock()
    .then((workspaceCount) => {
      console.log(`[workspace-lock] ${workspaceCount} workspace manifests and links agree with package-lock.json`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
