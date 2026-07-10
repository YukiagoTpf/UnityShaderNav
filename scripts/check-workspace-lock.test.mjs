import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkspaceLock } from './check-workspace-lock.mjs';

test('accepts matching workspace manifests, lock entries, and links', () => {
  const fixture = workspaceFixture();
  assert.equal(
    validateWorkspaceLock(fixture.rootPackage, fixture.workspacePackages, fixture.lockfile),
    3,
  );
});

test('reports manifest and lock version drift with both source paths', () => {
  const fixture = workspaceFixture();
  fixture.lockfile.packages.client.version = '0.0.6';

  assert.throws(
    () => validateWorkspaceLock(fixture.rootPackage, fixture.workspacePackages, fixture.lockfile),
    (error) => {
      assert.match(error.message, /package-lock\.json#packages\["client"\]\.version/);
      assert.match(error.message, /expected "0\.0\.7" from client\/package\.json#version/);
      assert.match(error.message, /received "0\.0\.6"/);
      return true;
    },
  );
});

test('reports a workspace link that resolves to the wrong directory', () => {
  const fixture = workspaceFixture();
  fixture.lockfile.packages['node_modules/unity-shader-nav'].resolved = 'legacy/client';

  assert.throws(
    () => validateWorkspaceLock(fixture.rootPackage, fixture.workspacePackages, fixture.lockfile),
    /package-lock\.json#packages\["node_modules\/unity-shader-nav"\]\.resolved expected "client"/,
  );
});

function workspaceFixture() {
  const manifests = {
    shared: { name: '@unity-shader-nav/shared', version: '0.0.1' },
    server: { name: '@unity-shader-nav/server', version: '0.0.1' },
    client: { name: 'unity-shader-nav', version: '0.0.7' },
  };
  const workspacePaths = Object.keys(manifests);
  const packages = {
    '': { workspaces: workspacePaths },
  };

  for (const [workspacePath, manifest] of Object.entries(manifests)) {
    packages[workspacePath] = { ...manifest };
    packages[`node_modules/${manifest.name}`] = {
      link: true,
      resolved: workspacePath,
    };
  }

  return {
    rootPackage: { workspaces: workspacePaths },
    workspacePackages: new Map(Object.entries(manifests)),
    lockfile: { packages },
  };
}
