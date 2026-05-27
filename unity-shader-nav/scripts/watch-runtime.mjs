// Keep the VS Code Extension Development Host runtime layout under client/out/
// current while debugging with F5. Reuses the deterministic root build pipeline
// (`npm run build`) instead of maintaining a parallel build path.
//
// Modes:
//   node scripts/watch-runtime.mjs --once   run one runtime build and exit
//   node scripts/watch-runtime.mjs          build once, then watch + rebuild
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function log(message) {
  console.log(`[watch-runtime] ${message}`);
}

// Run the root build script. Resolves with the child exit code. npm.cmd on
// Windows must be launched through a shell; passing the command as a single
// string (rather than an args array) avoids the DEP0190 shell-args warning,
// and the command contains only static literals so there is no injection risk.
function runBuild() {
  return new Promise((resolvePromise) => {
    const child = spawn(`${npmCommand} run build`, {
      cwd: monorepoRoot,
      stdio: 'inherit',
      shell: true,
    });
    child.on('error', (err) => {
      log(`build failed to start: ${err.message}`);
      resolvePromise(1);
    });
    child.on('exit', (code) => resolvePromise(code ?? 1));
  });
}

async function runOnce() {
  const code = await runBuild();
  if (code === 0) {
    log('build ok');
  } else {
    log(`build failed (exit ${code})`);
  }
  process.exit(code);
}

// Source and runtime-asset inputs that should trigger a rebuild. Generated
// output directories (client/out, server/out, shared/out, tests/out) are
// intentionally excluded so rebuild output does not retrigger a rebuild.
const watchTargets = [
  'shared/src',
  'server/src',
  'client/src',
  'server/grammars',
  'node_modules/web-tree-sitter/tree-sitter.js',
  'node_modules/web-tree-sitter/tree-sitter.wasm',
  'tsconfig.base.json',
  'shared/tsconfig.json',
  'server/tsconfig.json',
  'client/tsconfig.json',
  'shared/package.json',
  'server/package.json',
  'client/package.json',
  'scripts/copy-server.mjs',
  'scripts/build.mjs',
].map((relative) => resolve(monorepoRoot, relative));

async function watch() {
  log('starting initial runtime build');
  const initialCode = await runBuild();
  log(initialCode === 0 ? 'build ok' : `build failed (exit ${initialCode})`);

  let building = false;
  let rebuildQueued = false;
  let debounceTimer = null;

  async function rebuild() {
    if (building) {
      // A build is already running; queue exactly one follow-up.
      rebuildQueued = true;
      return;
    }
    building = true;
    do {
      rebuildQueued = false;
      log('rebuilding');
      const code = await runBuild();
      log(code === 0 ? 'build ok' : `build failed (exit ${code})`);
    } while (rebuildQueued);
    building = false;
  }

  function scheduleRebuild(changedPath) {
    log(`changed ${changedPath}`);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void rebuild();
    }, 250);
  }

  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    persistent: true,
  });

  watcher
    .on('add', scheduleRebuild)
    .on('change', scheduleRebuild)
    .on('unlink', scheduleRebuild)
    .on('error', (err) => log(`watcher error: ${err.message}`))
    .on('ready', () => log('watching for changes (Ctrl+C to stop)'));

  const shutdown = () => {
    log('stopping');
    void watcher.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv.includes('--once')) {
  await runOnce();
} else {
  await watch();
}
