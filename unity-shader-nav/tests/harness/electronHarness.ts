import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestOptions } from '@vscode/test-electron';

export type ElectronSuite = 'activation' | 'integration';

export interface ElectronHarnessConfig {
  repositoryRoot: string;
  fixtureRelativePath: string;
  suite: ElectronSuite;
  sandboxBase?: string;
}

export type ElectronRunner = (options: TestOptions) => Promise<unknown>;

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;
const DEFAULT_POSIX_SANDBOX_BASE = '/tmp';
const DARWIN_SOCKET_PATH_LIMIT = 104;
const REPRESENTATIVE_SOCKET_NAME = '1.85-main.sock';

const FIXTURE_ROOTS = [
  'tests/fixtures',
  'tests/integration/client/fixtures',
  'server/tests/include/fixtures',
  'server/tests/workspace/fixtures',
] as const;

const EXTENSION_RUNTIME_PATHS = [
  'package.json',
  'out',
  'images',
  'language-configuration',
] as const;

interface SandboxLayout {
  root: string;
  extensionDevelopmentPath: string;
  extensionTestsPath: string;
  workspaceFile: string;
  userDataDir: string;
  extensionsDir: string;
  tempDir: string;
}

export function parseElectronSuite(args: readonly string[]): ElectronSuite {
  let value: string | undefined;
  if (args.length === 1 && args[0].startsWith('--suite=')) {
    value = args[0].slice('--suite='.length);
  } else if (args.length === 2 && args[0] === '--suite') {
    value = args[1];
  }

  if (value === 'activation' || value === 'integration') return value;
  throw new Error('Expected --suite activation or --suite integration');
}

export async function readPinnedVsCodeVersion(repositoryRoot: string): Promise<string> {
  const versionPath = path.join(repositoryRoot, 'tests', 'vscode-version.txt');
  const version = (await fs.readFile(versionPath, 'utf8')).trim();
  if (!EXACT_VERSION_RE.test(version)) {
    throw new Error(
      `tests/vscode-version.txt must contain an exact x.y.z version, got ${JSON.stringify(version)}`,
    );
  }
  return version;
}

/**
 * Owns the complete Electron test lifecycle: short-path staging, fixed runtime
 * selection, disposable process state, and cleanup on every exit path.
 */
export async function runElectronHarness(
  config: ElectronHarnessConfig,
  runner: ElectronRunner,
): Promise<void> {
  const repositoryRoot = path.resolve(config.repositoryRoot);
  const version = await readPinnedVsCodeVersion(repositoryRoot);
  const sandboxBase = path.resolve(
    config.sandboxBase
      ?? process.env.USN_TEST_TMPDIR
      ?? (process.platform === 'win32' ? os.tmpdir() : DEFAULT_POSIX_SANDBOX_BASE),
  );
  await fs.mkdir(sandboxBase, { recursive: true });

  const createdRoot = await fs.mkdtemp(path.join(sandboxBase, 'usn-'));
  try {
    const layout = await stageSandbox(createdRoot, repositoryRoot, config.fixtureRelativePath);
    assertShortDarwinIpcPath(layout.userDataDir);

    const options: TestOptions = {
      version,
      cachePath: path.join(repositoryRoot, '.vscode-test'),
      reuseMachineInstall: false,
      extensionDevelopmentPath: layout.extensionDevelopmentPath,
      extensionTestsPath: layout.extensionTestsPath,
      extensionTestsEnv: {
        TMPDIR: layout.tempDir,
        TMP: layout.tempDir,
        TEMP: layout.tempDir,
        USN_HARNESS_ROOT: layout.root,
        USN_TEST_SUITE: config.suite,
      },
      launchArgs: [
        layout.workspaceFile,
        '--disable-extensions',
        `--user-data-dir=${layout.userDataDir}`,
        `--extensions-dir=${layout.extensionsDir}`,
      ],
    };

    console.log(`[electron-harness] VS Code ${version}; suite=${config.suite}; root=${layout.root}`);
    await runner(options);
  } finally {
    await fs.rm(createdRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

async function stageSandbox(
  root: string,
  repositoryRoot: string,
  fixtureRelativePath: string,
): Promise<SandboxLayout> {
  const extensionDevelopmentPath = path.join(root, 'e');
  const mirrorRoot = path.join(root, 't');
  const workspaceFolder = path.join(root, 'w');
  const workspaceFile = path.join(root, 'ws.code-workspace');
  const userDataDir = path.join(root, 'u');
  const extensionsDir = path.join(root, 'x');
  const tempDir = path.join(root, 'm');

  const fixtureSource = resolveFixtureSource(repositoryRoot, fixtureRelativePath);
  for (const relativePath of EXTENSION_RUNTIME_PATHS) {
    await copyWithoutLibrary(
      path.join(repositoryRoot, 'client', relativePath),
      path.join(extensionDevelopmentPath, relativePath),
    );
  }
  await copyWithoutLibrary(
    path.join(repositoryRoot, 'tests', 'out'),
    path.join(mirrorRoot, 'tests', 'out'),
  );
  await copyWithoutLibrary(
    path.join(repositoryRoot, 'tests', 'integration', 'client', 'fixtures'),
    path.join(mirrorRoot, 'tests', 'integration', 'client', 'fixtures'),
  );
  await copyWithoutLibrary(
    path.join(repositoryRoot, 'server', 'tests', 'include', 'fixtures'),
    path.join(mirrorRoot, 'server', 'tests', 'include', 'fixtures'),
  );
  await copyWithoutLibrary(
    path.join(repositoryRoot, 'server', 'tests', 'workspace', 'fixtures'),
    path.join(mirrorRoot, 'server', 'tests', 'workspace', 'fixtures'),
  );
  await copyWithoutLibrary(fixtureSource, workspaceFolder);

  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(extensionsDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  const repositoryNodeModules = path.join(repositoryRoot, 'node_modules');
  await fs.stat(repositoryNodeModules);
  await fs.symlink(
    repositoryNodeModules,
    path.join(mirrorRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  await fs.writeFile(
    workspaceFile,
    JSON.stringify({ folders: [{ path: workspaceFolder }] }, null, 2),
  );

  return {
    root,
    extensionDevelopmentPath,
    extensionTestsPath: path.join(mirrorRoot, 'tests', 'out', 'client', 'suite'),
    workspaceFile,
    userDataDir,
    extensionsDir,
    tempDir,
  };
}

function resolveFixtureSource(repositoryRoot: string, fixtureRelativePath: string): string {
  if (path.isAbsolute(fixtureRelativePath)) {
    throw new Error(`USN_TEST_FIXTURE must be repository-relative: ${fixtureRelativePath}`);
  }

  const fixtureSource = path.resolve(repositoryRoot, fixtureRelativePath);
  const allowed = FIXTURE_ROOTS.some((relativeRoot) =>
    isWithin(path.join(repositoryRoot, relativeRoot), fixtureSource));
  if (!allowed) {
    throw new Error(
      `USN_TEST_FIXTURE must stay under a known fixture root: ${fixtureRelativePath}`,
    );
  }
  return fixtureSource;
}

async function copyWithoutLibrary(source: string, target: string): Promise<void> {
  await fs.stat(source);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, {
    recursive: true,
    filter: (candidate) => {
      const relativePath = path.relative(source, candidate);
      return !relativePath.split(path.sep).includes('Library');
    },
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === ''
    || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function assertShortDarwinIpcPath(userDataDir: string): void {
  if (process.platform !== 'darwin') return;
  const representativeSocket = path.join(userDataDir, REPRESENTATIVE_SOCKET_NAME);
  const bytes = Buffer.byteLength(representativeSocket);
  if (bytes >= DARWIN_SOCKET_PATH_LIMIT) {
    throw new Error(
      `Electron user-data path leaves no macOS IPC socket budget (${bytes} bytes): ${userDataDir}`,
    );
  }
}
