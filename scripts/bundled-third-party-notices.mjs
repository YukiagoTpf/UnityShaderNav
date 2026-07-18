import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const LICENSE_FILE_RE = /^licen[cs]e(?:$|[._-])/i;

export async function createBundledThirdPartyNotices({ repositoryRoot, metafiles }) {
  if (!Array.isArray(metafiles) || metafiles.length !== 2) {
    throw new Error('third-party notices require exactly two esbuild metafiles');
  }
  const packages = new Map();
  for (const packageRoot of packageRootsFrom(repositoryRoot, metafiles)) {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const name = requireNonEmptyManifestString(manifest, 'name');
    const version = requireNonEmptyManifestString(manifest, 'version');
    if (typeof manifest.license !== 'string' || manifest.license.trim().length === 0) {
      throw new Error(
        `bundled package ${name}@${version} has no declared license`,
      );
    }
    const licenseFiles = (await readdir(packageRoot))
      .filter((entry) => LICENSE_FILE_RE.test(entry))
      .sort();
    if (licenseFiles.length === 0) {
      throw new Error(
        `bundled package ${name}@${version} has no LICENSE file`,
      );
    }
    const licenseTexts = await Promise.all(licenseFiles.map(async (file) => ({
      file,
      text: await readFile(join(packageRoot, file), 'utf8'),
    })));
    const packageKey = `${name}@${version}`;
    const bundledPackage = {
      name,
      version,
      license: manifest.license,
      licenseTexts,
    };
    const existing = packages.get(packageKey);
    if (existing && JSON.stringify(existing) !== JSON.stringify(bundledPackage)) {
      throw new Error(`conflicting license evidence for bundled package ${packageKey}`);
    }
    if (!existing) packages.set(packageKey, bundledPackage);
  }

  const sortedPackages = [...packages.values()].sort((left, right) => (
    compareText(left.name, right.name) || compareText(left.version, right.version)
  ));
  return renderNotices(sortedPackages);
}

function requireNonEmptyManifestString(manifest, field) {
  const value = manifest[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`bundled package manifest ${field} must be a non-empty string`);
  }
  return value;
}

export async function writeBundledThirdPartyNotices({ outputPath, ...options }) {
  try {
    const notices = await createBundledThirdPartyNotices(options);
    await writeFile(outputPath, notices);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

function packageRootsFrom(repositoryRoot, metafiles) {
  const roots = new Set();
  for (const metafile of metafiles) {
    for (const inputPath of Object.keys(metafile.inputs)) {
      const segments = inputPath.replaceAll('\\', '/').split('/');
      const nodeModulesIndex = segments.lastIndexOf('node_modules');
      if (nodeModulesIndex < 0 || !segments[nodeModulesIndex + 1]) continue;
      const packageEnd = segments[nodeModulesIndex + 1].startsWith('@')
        ? nodeModulesIndex + 3
        : nodeModulesIndex + 2;
      roots.add(resolve(repositoryRoot, segments.slice(0, packageEnd).join('/')));
    }
  }
  return roots;
}

function renderNotices(packages) {
  const sections = [
    'UnityShaderNav Third-Party Notices',
    '',
    'The following packages are bundled into the extension and server JavaScript files.',
  ];
  for (const bundledPackage of packages) {
    sections.push(
      '',
      '================================================================================',
      `Package: ${bundledPackage.name}`,
      `Version: ${bundledPackage.version}`,
      `License: ${bundledPackage.license}`,
    );
    for (const license of bundledPackage.licenseTexts) {
      sections.push(
        `License file: ${license.file}`,
        '--------------------------------------------------------------------------------',
        license.text.endsWith('\n') ? license.text.slice(0, -1) : license.text,
      );
    }
  }
  return `${sections.join('\n')}\n`;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
