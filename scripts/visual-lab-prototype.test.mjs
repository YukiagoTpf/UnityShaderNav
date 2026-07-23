import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'tools', 'gpu-capture-prototype', 'UnityProject');

test('real prototype owns one isolated Unity process and two explicit requests', async () => {
  const runner = await readFile(
    join(root, 'scripts', 'visual-lab-prototype.mjs'),
    'utf8',
  );
  assert.match(runner, /'visual-lab-render\/v1'/);
  assert.match(runner, /'describe-preview-target'/);
  assert.match(runner, /'render-preview'/);
  assert.match(runner, /'before'/);
  assert.match(runner, /'after'/);
  assert.match(runner, /validateVisualLabTargetDescription/);
  assert.match(runner, /validateVisualLabFrameEvidence/);
  assert.match(runner, /mask\.nanPixelCount !== 64/);
  assert.match(runner, /mask\.infinitePixelCount !== 64/);
  assert.match(runner, /mask\.maskedPixelCount !== 128/);
  assert.match(runner, /compileFixtureAdapter/);
  assert.match(runner, /DotNetSdkRoslyn/);
  assert.match(runner, /UnityShaderNav\.Adapter\.Editor\.dll/);
  assert.match(runner, /child\.kill\('SIGTERM'\)/);
  assert.match(runner, /child\.kill\('SIGKILL'\)/);
  assert.match(runner, /'-noUpm'/);
  assert.doesNotMatch(runner, /Skywalker|product project|Assets\/Scenes/i);
});

test('controlled input and UPM Adapter are repository-owned', async () => {
  const manifest = JSON.parse(
    await readFile(join(project, 'Packages', 'manifest.json'), 'utf8'),
  );
  const adapter = manifest.dependencies[
    'com.yukiagotpf.unity-shader-nav-adapter'
  ];
  assert.equal(adapter, 'file:../../../unity-adapter');
  assert.equal(
    resolve(project, adapter.slice('file:'.length)),
    join(root, 'unity-adapter'),
  );

  const shader = await readFile(
    join(project, 'Assets', 'Shaders', 'VisualLabProbe.shader'),
    'utf8',
  );
  assert.match(shader, /Name "VisualLabForward"/);
  assert.match(shader, /#pragma fragment frag/);
  assert.match(shader, /asfloat\(0x7fc00000\)/);
  assert.match(shader, /asfloat\(0x7f800000\)/);

  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\*\*\/Temp\/$/m);
  assert.match(
    ignore,
    /^\*\*\/Assets\/UnityShaderNavVisualLabFixture\/$/m,
  );
});

test('public protocol keeps the diagnostic independent from image diff', async () => {
  const protocol = await readFile(join(root, 'shared', 'src', 'visualLab.ts'), 'utf8');
  const renderer = await readFile(
    join(root, 'unity-adapter', 'Editor', 'AdapterVisualLab.cs'),
    'utf8',
  );
  assert.match(protocol, /format: 'r8'/);
  assert.match(protocol, /origin: 'top-left'/);
  assert.match(protocol, /nanPixelCount/);
  assert.match(protocol, /infinitePixelCount/);
  assert.match(renderer, /IAdapterHostCapability/);
  assert.match(renderer, /IAdapterHostInvalidationSource/);
  assert.doesNotMatch(renderer, /image.?diff/i);

  const host = await readFile(
    join(root, 'unity-adapter', 'Editor', 'AdapterHost.cs'),
    'utf8',
  );
  assert.match(host, /"usn-" \+ EffectiveUserId\(\)/);
  assert.match(host, /Chmod\(runtimeDirectory/);
  assert.match(host, /Chmod\(endpoint/);
});
