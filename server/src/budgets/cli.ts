import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  contractWithCurrentBaselines,
  evaluateShaderBudgets,
  formatShaderBudgetReport,
  parseShaderBudgetContract,
} from './shaderBudget';

interface CliOptions {
  readonly config: string;
  readonly json: string;
  readonly writeBaseline: boolean;
}

function usage(): string {
  return [
    'Usage: npm run check:shader-budgets -- [options]',
    '',
    'Options:',
    '  --config <path>       Budget contract (default: shader-budgets.json)',
    '  --json <path|->       Machine report (default: Library/UnityShaderNavReports/shader-budget-report.json)',
    '  --write-baseline      Replace baselines with current verified measurements',
    '  --help                Show this help',
  ].join('\n');
}

function parseArgs(args: readonly string[]): CliOptions | null {
  let config = 'shader-budgets.json';
  let json = 'Library/UnityShaderNavReports/shader-budget-report.json';
  let writeBaseline = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') return null;
    if (argument === '--write-baseline') {
      writeBaseline = true;
      continue;
    }
    if (argument === '--config' || argument === '--json') {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a path.`);
      if (argument === '--config') config = value;
      else json = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { config, json, writeBaseline };
}

async function main(): Promise<void> {
  let options: CliOptions | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (!options) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const configPath = resolve(options.config);
  let contract;
  try {
    contract = parseShaderBudgetContract(
      JSON.parse(await readFile(configPath, 'utf8')),
    );
  } catch (error) {
    process.stderr.write(
      `Invalid Shader budget contract '${options.config}': `
      + `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const contractDirectory = dirname(configPath);
  let report = await evaluateShaderBudgets(contract, contractDirectory);
  if (options.writeBaseline) {
    try {
      contract = contractWithCurrentBaselines(contract, report);
      await writeFile(
        configPath,
        `${JSON.stringify(contract, null, 2)}\n`,
        'utf8',
      );
      report = await evaluateShaderBudgets(contract, contractDirectory);
    } catch (error) {
      process.stderr.write(
        `Shader budget baseline was not written: `
        + `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const machine = `${JSON.stringify(report, null, 2)}\n`;
  const human = `${formatShaderBudgetReport(report)}\n`;
  if (options.json === '-') {
    process.stdout.write(machine);
    process.stderr.write(human);
  } else {
    const reportPath = resolve(options.json);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, machine, 'utf8');
    process.stdout.write(human);
    process.stdout.write(`Machine report: ${options.json.replace(/\\/g, '/')}\n`);
  }
  process.exitCode = report.status === 'pass' ? 0 : 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Shader budget verification crashed: `
    + `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
