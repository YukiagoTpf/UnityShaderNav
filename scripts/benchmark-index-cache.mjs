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
  const root = await mkdtemp(join(tmpdir(), 'usn-index-cache-bench-'));
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

function createProgressRecorder() {
  const events = [];
  const record = (kind, message) => {
    if (typeof message === 'string') events.push({ kind, message });
  };
  return {
    events,
    connection: {
      console: { log() {}, warn() {}, error() {} },
      window: {
        createWorkDoneProgress: async () => ({
          begin(_title, _percentage, message) {
            record('begin', message);
          },
          report(message) {
            record('report', message);
          },
          done() {
            events.push({ kind: 'done', message: '' });
          },
        }),
      },
    },
  };
}

function findVisibleSymbol(workspace) {
  for (const query of 'abcdefghijklmnopqrstuvwxyz0123456789_') {
    const match = workspace.workspaceSymbols(query)[0];
    if (match) return match.name;
  }
  return undefined;
}

function assertBenchmark(condition, message) {
  if (!condition) throw new Error(`Index-cache benchmark failed: ${message}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args.project ? resolve(args.project) : await createSyntheticProject(args.files);
  const synthetic = args.project === undefined;

  const [{ Workspace }, { chooseCacheDir }, { DEFAULT_SETTINGS }] = await Promise.all([
    import('../server/out/workspace/workspace.js'),
    import('../server/out/cache/cacheManager.js'),
    import('../shared/out/protocol.js'),
  ]);

  let coldWorkspace;
  let warmWorkspace;

  try {
    const folderUri = pathToFileURL(projectRoot).href;
    const cacheDir = chooseCacheDir({
      unityProjectRoot: projectRoot,
      workspaceFolderUri: folderUri,
      globalStorageDir: undefined,
    });
    assertBenchmark(cacheDir !== null, 'production cache location is unavailable');
    const cachePath = join(cacheDir, 'index.json');

    const coldProgress = createProgressRecorder();
    coldWorkspace = new Workspace(folderUri, DEFAULT_SETTINGS);
    const coldStart = performance.now();
    await coldWorkspace.initialize(coldProgress.connection);
    const coldMs = performance.now() - coldStart;
    const symbolName = synthetic ? 'BenchFunction0' : findVisibleSymbol(coldWorkspace);
    assertBenchmark(symbolName !== undefined, 'cold index exposes no visible workspace symbol');
    coldWorkspace.dispose();
    coldWorkspace = undefined;

    const warmProgress = createProgressRecorder();
    warmWorkspace = new Workspace(folderUri, DEFAULT_SETTINGS);
    const warmStart = performance.now();
    await warmWorkspace.initialize(warmProgress.connection);
    const warmMs = performance.now() - warmStart;
    const warmRestored = warmProgress.events.some((event) => (
      event.kind === 'begin' && event.message === 'restoring cache...'
    ));
    const symbolAvailable = warmWorkspace.workspaceSymbols(symbolName)
      .some((symbol) => symbol.name === symbolName);

    const persistStart = performance.now();
    await warmWorkspace.persist();
    const persistMs = performance.now() - persistStart;

    const cacheBytes = await fileSizeOrZero(cachePath);
    assertBenchmark(cacheBytes > 0, `expected a non-empty manifest at ${cachePath}`);
    assertBenchmark(warmRestored, 'warm initialization did not enter cache restoration');
    assertBenchmark(symbolAvailable, `warm index does not expose ${symbolName}`);

    const result = {
      projectRoot,
      synthetic,
      files: await countShaderFiles(projectRoot),
      cachePath,
      cacheBytes,
      coldMs,
      warmMs,
      persistMs,
      warmRestored,
      symbolName,
      symbolAvailable,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    coldWorkspace?.dispose();
    warmWorkspace?.dispose();
    if (synthetic && !args.keep) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
