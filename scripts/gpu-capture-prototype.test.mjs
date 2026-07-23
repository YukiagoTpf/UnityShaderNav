import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'tools', 'gpu-capture-prototype', 'UnityProject');
const shaderPath = join(project, 'Assets', 'Shaders', 'CaptureProbe.shader');
const evidencePath = join(
  root,
  'server',
  'tests',
  'adapter',
  'fixtures',
  'gpu-capture',
  'CaptureProbe.evidence.json',
);

test('prototype uses the accepted isolated Metal capture path', async () => {
  const runner = await readFile(
    join(root, 'scripts', 'gpu-capture-prototype.mjs'),
    'utf8',
  );
  const adapter = await readFile(
    join(project, 'Assets', 'Editor', 'GpuCapturePrototype.cs'),
    'utf8',
  );
  assert.match(runner, /'-noUpm'/);
  assert.match(runner, /'-enable-metal-capture'/);
  assert.match(runner, /MTL_CAPTURE_ENABLED: '1'/);
  assert.match(runner, /USN_MACOS_BUILD_VERSION/);
  assert.match(runner, /USN_METAL_VERSION/);
  assert.match(runner, /USN_UNITY_BINARY_VERSION/);
  assert.match(runner, /USN_CAPTURE_INSTANCE_ID/);
  assert.match(runner, /SPDisplaysDataType/);
  assert.match(runner, /'-quit'/);
  assert.match(runner, /'--trace',\s+trace/);
  assert.match(runner, /'--gpu-name',\s+facts\.gpuName/);
  assert.match(runner, /'--unity-version',\s+facts\.unityVersion/);
  assert.match(runner, /'--unity-binary',\s+facts\.unityBinaryVersion/);
  assert.match(runner, /CaptureProbe\.shader\.meta/);
  assert.match(runner, /spawnSync\(/);
  assert.match(runner, /timeout = 30_000/);
  assert.match(runner, /timeout: 300_000/);
  assert.match(runner, /ETIMEDOUT/);
  assert.match(runner, /rmSync\(evidence, \{ force: true \}\)/);
  assert.match(runner, /provenance\?\.instanceId !== captureInstanceId/);
  assert.doesNotMatch(runner, /shell:\s*true/);
  assert.match(adapter, /FrameCapture\.BeginCaptureToFile\(tracePath\)/);
  assert.match(adapter, /Graphics\.ExecuteCommandBuffer\(commands\)/);
  assert.match(adapter, /commands\.DrawMesh\(/);
  assert.match(adapter, /FrameCapture\.EndCapture\(\)/);
  assert.match(adapter, /AssetDatabase\.ImportAsset\(/);
  assert.match(adapter, /RequireSourceRevision\(sourceBytes\)/);
  assert.match(adapter, /sourceHash\.Substring\(0, 12\)/);
  assert.match(adapter, /incomplete = true/);
  assert.doesNotMatch(adapter, /Assets\/Scenes|product project/i);
});

test('sanitized evidence is bound to the authoritative source and GUID', async () => {
  const source = await readFile(shaderPath, 'utf8');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const meta = await readFile(`${shaderPath}.meta`, 'utf8');
  const contentHash = createHash('sha256').update(source, 'utf8').digest('hex');
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const mapped = evidence.mapping.range;

  assert.equal(evidence.provenance.sourceRevision.contentHash, contentHash);
  assert.equal(evidence.provenance.unityBinaryVersion, '2022.3.62f1');
  assert.match(
    meta,
    new RegExp(`^guid: ${evidence.provenance.sourceRevision.assetGuid}$`, 'm'),
  );
  assert.equal(
    lines[mapped.start.line].slice(mapped.start.character, mapped.end.character),
    evidence.mapping.expectedText,
  );
  assert.equal(evidence.mapping.expectedText, evidence.context.entryPoint);
  assert.equal(evidence.context.keywords.incomplete, true);
  assert.match(evidence.draw.label, new RegExp(contentHash.slice(0, 12)));
  assert.match(evidence.draw.label, new RegExp(evidence.context.id));
  assert.equal(evidence.draw.trace.storage, 'local-ephemeral');
  assert.equal(evidence.draw.trace.fileName, 'CaptureProbe.gputrace');
  assert.doesNotMatch(JSON.stringify(evidence), /\/Users\/|[A-Za-z]:\\\\/);
});

test('raw captures and Unity user/generated state stay outside Git', async () => {
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  const attributes = await readFile(join(root, '.gitattributes'), 'utf8');
  const manifest = JSON.parse(
    await readFile(join(project, 'Packages', 'manifest.json'), 'utf8'),
  );

  assert.match(ignore, /^\*\.gputrace$/m);
  assert.match(ignore, /^\*\*\/Library\/$/m);
  assert.match(ignore, /^\*\*\/Logs\/$/m);
  assert.match(ignore, /^\*\*\/UserSettings\/$/m);
  assert.match(
    attributes,
    /^tools\/gpu-capture-prototype\/\*\*\/\*\.shader text eol=lf$/m,
  );
  assert.deepEqual(manifest, { dependencies: {} });
});
