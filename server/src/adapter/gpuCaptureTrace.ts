import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { GpuCaptureTraceVerification } from '@unity-shader-nav/shared';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * Xcode `.gputrace` documents contain relative file symlinks for deduplicated
 * resources. Follow only links whose final regular-file target remains inside
 * the real trace root. Hash the link path plus target bytes to match the Unity
 * emitter's Directory.GetFiles/File.ReadAllBytes tree identity.
 */
async function traceFiles(path: string): Promise<string[]> {
  const rootEntry = await lstat(path);
  if (rootEntry.isSymbolicLink()) throw new Error('trace root must not be a symlink');
  if (rootEntry.isFile()) return [path];
  if (!rootEntry.isDirectory()) {
    throw new Error('trace path is not a file or directory');
  }
  const root = await realpath(path);
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const child of (await readdir(directory)).sort()) {
      const childPath = resolve(directory, child);
      const childEntry = await lstat(childPath);
      if (childEntry.isSymbolicLink()) {
        const target = await realpath(childPath);
        if (!inside(root, target)) {
          throw new Error('trace document symlink escapes its root');
        }
        if (!(await stat(target)).isFile()) {
          throw new Error('trace document symlink must resolve to a regular file');
        }
        result.push(childPath);
      } else if (childEntry.isDirectory()) {
        await visit(childPath);
      } else if (childEntry.isFile()) {
        result.push(childPath);
      }
    }
  };
  await visit(path);
  return result.sort();
}

export async function verifyLocalGpuTrace(
  path: string,
  expectedLabel: string | undefined,
): Promise<GpuCaptureTraceVerification> {
  const files = await traceFiles(path);
  const root = await lstat(path);
  let byteLength = 0;
  let labelFound = false;
  if (root.isFile()) {
    const bytes = await readFile(path);
    byteLength = bytes.byteLength;
    labelFound = expectedLabel !== undefined
      && bytes.includes(Buffer.from(expectedLabel, 'utf8'));
    return {
      status: 'verified-local-trace',
      fileName: basename(path),
      sha256: sha256(bytes),
      byteLength,
      labels: labelFound && expectedLabel ? [expectedLabel] : [],
    };
  }
  let identity = '';
  for (const file of files) {
    const bytes = await readFile(file);
    byteLength += bytes.byteLength;
    if (
      expectedLabel !== undefined
      && bytes.includes(Buffer.from(expectedLabel, 'utf8'))
    ) labelFound = true;
    identity += `${file.slice(path.length).replace(/\\/g, '/')}\0${sha256(bytes)}\n`;
  }
  return {
    status: 'verified-local-trace',
    fileName: basename(path),
    sha256: sha256(Buffer.from(identity, 'utf8')),
    byteLength,
    labels: labelFound && expectedLabel ? [expectedLabel] : [],
  };
}
