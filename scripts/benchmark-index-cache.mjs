import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const shaderExtensions = new Set(['.shader', '.hlsl', '.cginc', '.hlslinc', '.compute']);

function parseArgs(argv) {
  const args = {
    files: 800,
    project: undefined,
    keep: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--files') {
      args.files = Number(argv[++i]);
    } else if (arg === '--project') {
      args.project = argv[++i];
    } else if (arg === '--keep') {
      args.keep = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.files) || args.files < 1) {
    throw new Error('--files must be a positive integer');
  }

  return args;
}

async function createSyntheticProject(fileCount) {
  const root = await mkdtemp(join(tmpdir(), 'usn-issue3-bench-'));
  await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');

  for (let i = 0; i < fileCount; i++) {
    const body = [
      `struct BenchInput${i} { float3 positionWS; };`,
      `float4 BenchFunction${i}(BenchInput${i} input) {`,
      `  return float4(input.positionWS, ${(i % 17) / 16});`,
      '}',
      '',
    ].join('\n');
    await writeFile(join(root, 'Assets', 'Shaders', `Bench${i}.hlsl`), body, 'utf8');
  }

  return root;
}

async function countShaderFiles(root) {
  let count = 0;

  async function recur(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await recur(path);
      } else {
        const dot = entry.name.lastIndexOf('.');
        const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : '';
        if (shaderExtensions.has(ext)) count++;
      }
    }
  }

  await recur(root);
  return count;
}

async function fileSizeOrZero(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args.project ? resolve(args.project) : await createSyntheticProject(args.files);
  const synthetic = args.project === undefined;

  const [{ Workspace }, { DEFAULT_SETTINGS }] = await Promise.all([
    import('../server/out/workspace/workspace.js'),
    import('../shared/out/protocol.js'),
  ]);

  const fakeConnection = {
    console: { log() {} },
    window: {
      createWorkDoneProgress: async () => ({
        begin() {},
        report() {},
        done() {},
      }),
    },
  };

  try {
    const folderUri = pathToFileURL(projectRoot).href;
    const coldWorkspace = new Workspace(folderUri, DEFAULT_SETTINGS);
    const coldStart = performance.now();
    await coldWorkspace.bootstrap(fakeConnection);
    const coldMs = performance.now() - coldStart;

    const warmWorkspace = new Workspace(folderUri, DEFAULT_SETTINGS);
    const warmStart = performance.now();
    await warmWorkspace.bootstrap(fakeConnection);
    const warmMs = performance.now() - warmStart;

    const persistStart = performance.now();
    await warmWorkspace.persist();
    const persistMs = performance.now() - persistStart;

    const cachePath = join(projectRoot, 'Library', 'UnityShaderNavCache', 'index.json');
    const result = {
      projectRoot,
      synthetic,
      files: await countShaderFiles(projectRoot),
      coldMs,
      warmMs,
      persistMs,
      cacheBytes: await fileSizeOrZero(cachePath),
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (synthetic && !args.keep) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
