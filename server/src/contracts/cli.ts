import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  contractWithCurrentBaselines,
  evaluateShaderBudgets,
  parseShaderBudgetContract,
} from '../budgets/shaderBudget';
import {
  contractWithCurrentWarningBaselines,
  evaluateShaderCompileContract,
  formatShaderCompileReport,
  parseShaderCompileContract,
  shaderCompileExitCode,
} from './shaderCompileContract';

interface CliOptions {
  readonly config: string;
  readonly json: string;
  readonly writeBaseline: boolean;
}

function usage(): string {
  return [
    'Usage: npm run check:shader-contract -- [options]',
    '',
    'Options:',
    '  --config <path>       Compile contract (default: shader-compile-contract.json)',
    '  --json <path|->       Machine report (default: Library/UnityShaderNavReports/shader-compile-contract-report.json)',
    '  --write-baseline      Replace warning and Variant budget baselines with verified evidence',
    '  --help                Show this help',
  ].join('\n');
}

function parseArgs(args: readonly string[]): CliOptions | null {
  let config = 'shader-compile-contract.json';
  let json = 'Library/UnityShaderNavReports/shader-compile-contract-report.json';
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
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
    process.exitCode = 3;
    return;
  }
  if (!options) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const configPath = resolve(options.config);
  let contract;
  try {
    contract = parseShaderCompileContract(
      JSON.parse(await readFile(configPath, 'utf8')),
    );
  } catch (error) {
    process.stderr.write(
      `Invalid Shader compile contract '${options.config}': `
      + `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 3;
    return;
  }

  const contractDirectory = dirname(configPath);
  let report = await evaluateShaderCompileContract(contract, contractDirectory);
  if (options.writeBaseline) {
    try {
      const nextContract = contractWithCurrentWarningBaselines(contract, report);
      const budgetPath = resolve(contractDirectory, contract.variantBudgets);
      const budgetContract = parseShaderBudgetContract(
        JSON.parse(await readFile(budgetPath, 'utf8')),
      );
      const budgetReport = await evaluateShaderBudgets(
        budgetContract,
        dirname(budgetPath),
      );
      const nextBudgetContract = contractWithCurrentBaselines(
        budgetContract,
        budgetReport,
      );
      await writeFile(
        budgetPath,
        `${JSON.stringify(nextBudgetContract, null, 2)}\n`,
        'utf8',
      );
      await writeFile(
        configPath,
        `${JSON.stringify(nextContract, null, 2)}\n`,
        'utf8',
      );
      contract = nextContract;
      report = await evaluateShaderCompileContract(contract, contractDirectory);
    } catch (error) {
      process.stderr.write(
        `Shader compile baselines were not written: `
        + `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
      return;
    }
  }

  const machine = `${JSON.stringify(report, null, 2)}\n`;
  const human = `${formatShaderCompileReport(report)}\n`;
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

  process.exitCode = shaderCompileExitCode(report);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Shader compile contract verification crashed: `
    + `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 3;
});
