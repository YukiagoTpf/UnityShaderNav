import { cp, mkdtemp, rm } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export async function copyUnityProjectFixture(source: string): Promise<string> {
  const sandbox = await mkdtemp(resolve(tmpdir(), 'usn-unity-fixture-'));
  const projectRoot = resolve(sandbox, 'project');
  await cp(source, projectRoot, {
    recursive: true,
    filter: (candidate) => {
      const segments = relative(source, candidate).split(sep);
      return !segments.includes('Library');
    },
  });
  return projectRoot;
}

export async function removeCopiedUnityProject(projectRoot: string): Promise<void> {
  await rm(resolve(projectRoot, '..'), { recursive: true, force: true });
}
