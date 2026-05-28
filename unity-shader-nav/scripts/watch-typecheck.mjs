// Run all three workspace `tsc -w` typecheck watchers concurrently.
//
// The root `npm run watch --workspaces --if-present` runs workspaces in
// series, so because `tsc -w` never exits the second and third watchers
// would never start. This script spawns one `npm run watch -w <name>`
// per workspace in parallel, forwards stdio, and shuts the whole group
// down together on Ctrl+C or when any child exits.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const workspaces = [
  '@unity-shader-nav/shared',
  '@unity-shader-nav/server',
  'unity-shader-nav',
];

const children = [];
let shuttingDown = false;
let firstExitCode = null;

function log(message) {
  console.log(`[watch-typecheck] ${message}`);
}

// On Windows each child was launched through cmd.exe (shell: true); a
// direct child.kill() only signals the shell, so use taskkill /T /F to
// reap the whole tree (matches scripts/watch-runtime.mjs).
function killChild(child) {
  if (!child || child.exited) {
    return;
  }
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
      stdio: 'ignore',
    });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone between the null-check and the signal.
    }
  }
}

function killAll() {
  for (const child of children) {
    killChild(child);
  }
}

function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log('stopping');
  killAll();
  // Give children a tick to flush before exiting.
  setImmediate(() => process.exit(code ?? firstExitCode ?? 0));
}

for (const workspace of workspaces) {
  log(`starting watch for ${workspace}`);
  // Pass the command as a single string to avoid the DEP0190 shell-args
  // warning; all components are static literals so there is no injection risk.
  const child = spawn(`${npmCommand} run watch -w ${workspace}`, {
    cwd: monorepoRoot,
    stdio: 'inherit',
    shell: true,
  });
  child.workspace = workspace;
  child.exited = false;
  child.on('error', (err) => {
    log(`${workspace} failed to start: ${err.message}`);
    child.exited = true;
    if (firstExitCode === null) {
      firstExitCode = 1;
    }
    shutdown(1);
  });
  child.on('exit', (code) => {
    child.exited = true;
    log(`${workspace} exited with code ${code ?? 'null'}`);
    if (firstExitCode === null) {
      firstExitCode = code ?? 1;
    }
    // Any watcher exiting means the group is no longer fully running;
    // tear the rest down and surface the exit code.
    shutdown(code ?? 1);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
