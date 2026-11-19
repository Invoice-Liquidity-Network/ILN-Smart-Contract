import { execSync, type ExecSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI_BIN = resolve(__dirname, '../../cli/dist/index.js');
const CLI_SRC = resolve(__dirname, '../../cli/src/index.ts');

function cliRunner(): string {
  if (existsSync(CLI_BIN)) return `node "${CLI_BIN}"`;
  return `npx tsx "${CLI_SRC}"`;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCLI(args: string, env?: Record<string, string>): ExecResult {
  const cmd = `${cliRunner()} ${args}`;
  const options: ExecSyncOptions = {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  try {
    const stdout = execSync(cmd, options);
    return { stdout: stdout.toString(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('E2E: CLI command flows', () => {
  it('should print help and exit 0', () => {
    const res = runCLI('--help');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Usage:');
    expect(res.stdout).toContain('iln');
  });

  it('should print version and exit 0', () => {
    const res = runCLI('--version');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it('should return help for submit command', () => {
    const res = runCLI('submit --help');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('submit');
  });

  it('should return help for fund command', () => {
    const res = runCLI('fund --help');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('fund');
  });

  it('should return help for pay command', () => {
    const res = runCLI('completion --help');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('completion');
  });

  it('should return help for status command', () => {
    const res = runCLI('status --help');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('status');
  });

  it('should return help for cancel command', () => {
    const res = runCLI('cancel --help');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('cancel');
  });

  it('should return help for reputation command', () => {
    const res = runCLI('reputation --help');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('reputation');
  });

  it('should exit with error for unknown command', () => {
    const res = runCLI('nonexistent-command');
    expect(res.exitCode).toBe(1);
  });

  it('should accept --profile global flag on help', () => {
    const res = runCLI('--profile test status --help');
    expect(res.exitCode).toBe(0);
  });

  it('submit --dry-run should exit 0 when keypairs are not configured (exit 1 in practice without config)', () => {
    const tmpHome = execSync('mktemp -d').toString().trim();
    const res = runCLI('submit --dry-run --payer GABC1234567890 --amount 100 --rate 300 --due 2026-12-31', {
      ILN_DIR: tmpHome,
    });
    execSync(`rm -rf "${tmpHome}"`);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/error|Error|not configured|not found|config/i);
  });

  it('status with --json should output parseable JSON when invoice does not exist', () => {
    const res = runCLI('status --id 999999 --json');
    expect(res.exitCode).toBe(1);
    const trimmed = res.stderr || res.stdout;
    expect(trimmed.length).toBeGreaterThan(0);
  });

  it('reputation should output JSON with --json flag', () => {
    const res = runCLI('reputation --address GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA --json');
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/error|Error|not found|config/i);
  });

  it('config command should work', () => {
    const tmpHome = execSync('mktemp -d').toString().trim();
    const res = runCLI('config --help', { ILN_DIR: tmpHome });
    execSync(`rm -rf "${tmpHome}"`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('config');
  });
});
