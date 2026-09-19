import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeDir, tempDir } from './helpers.js';

/**
 * The only test that runs the real binary: `node packages/cli/dist/bin.js`. It uses the demo battle,
 * so it needs no agent CLI, no network and no model spend, and it asserts on the JSON the CLI prints
 * rather than on anything mocked. Budget: well under 90 seconds.
 *
 * Spawning goes through node:child_process with an argument array (packages/cli has no execa
 * dependency and this file must not add one).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const bin = path.join(packageDir, 'dist', 'bin.js');

interface DemoJson {
  id: string;
  status: string;
  reportPath: string;
  runs: { a: { status: string }; b: { status: string } };
}

let home: string;
let built = false;
let skipReason = '';

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnCollect(command: string, args: string[], opts: { shell?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      shell: opts.shell === true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ stdout, stderr: stderr + String(err), exitCode: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

function arena(args: string[]): Promise<RunResult> {
  return spawnCollect(process.execPath, [bin, ...args]);
}

beforeAll(async () => {
  home = tempDir('smoke');
  if (!fs.existsSync(bin)) {
    // shell:true so the pnpm shim resolves on Windows as well as POSIX
    const build = await spawnCollect('pnpm', ['--filter', 'harness-arena', 'run', 'build'], { shell: true });
    if (build.exitCode !== 0 || !fs.existsSync(bin)) {
      skipReason =
        'packages/cli/dist/bin.js is missing and `pnpm --filter harness-arena run build` did not produce it: ' +
        build.stderr.slice(0, 300);
      return;
    }
  }
  built = true;
}, 120_000);

afterAll(() => {
  if (home) removeDir(home);
});

describe('the built CLI', () => {
  it('runs the demo battle, lists it and replays it', async () => {
    // This is the only test that starts the real binary: a missing or unbuildable dist/bin.js is a
    // failure, never a pass. A verdict that can go green on zero work says nothing.
    if (!built) throw new Error(skipReason);

    const demo = await arena(['demo', '--json', '--home', home]);
    expect(demo.exitCode, demo.stderr).toBe(0);
    const record = JSON.parse(demo.stdout) as DemoJson;
    expect(record.status).toBe('completed');
    expect(record.runs.a.status).toBe('completed');
    expect(record.runs.b.status).toBe('completed');
    expect(fs.existsSync(record.reportPath)).toBe(true);

    const list = await arena(['list', '--json', '--home', home]);
    expect(list.exitCode, list.stderr).toBe(0);
    const listed = JSON.parse(list.stdout) as {
      count: number;
      battles: Array<{ id: string; demo: boolean }>;
    };
    expect(listed.count).toBe(1);
    expect(listed.battles[0]?.id).toBe(record.id);
    expect(listed.battles[0]?.demo).toBe(true);

    const replay = await arena(['replay', record.id, '--json', '--home', home]);
    expect(replay.exitCode, replay.stderr).toBe(0);
    const replayed = JSON.parse(replay.stdout) as { id: string; events: number; reportPath: string };
    expect(replayed.id).toBe(record.id);
    expect(replayed.events).toBeGreaterThan(0);
    expect(fs.readFileSync(replayed.reportPath, 'utf8')).toContain('<!doctype html>');
  }, 90_000);
});
