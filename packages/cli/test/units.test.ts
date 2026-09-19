import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArenaEvent, BattleRecord } from '@harness-arena/protocol';
import type { Uploader } from '@harness-arena/core';
import { createProgram } from '../src/program.js';
import { parseDuration, parseExclusions, parseIssueRef, parseUploadLevel } from '../src/spec.js';
import { createLazyUploader } from '../src/runner.js';
import { createUi, formatMetric } from '../src/ui.js';
import { resolveServerUrl, DEFAULT_SERVER_URL } from '../src/config.js';
import { deviceName } from '../src/commands/login.js';
import { rewriteHome } from '../src/commands/demo.js';
import {
  headlineLine,
  regressionMarkdown,
  rowFromRecord,
  summarizeRegression,
} from '../src/commands/regression.js';
import { fakeRecord, metric, removeDir, stubAdapter, tempDir, testHarness } from './helpers.js';

/** Fake credentials only: these strings never leave the test process. */
const FAKE_TOKEN = 'test-device-token';
const FAKE_PREFIX = 'test-dev';

let home: string;

beforeEach(() => {
  home = tempDir('units');
});

afterEach(() => {
  removeDir(home);
});

describe('duration parsing', () => {
  it('reads suffixed and compound durations', () => {
    expect(parseDuration('20m')).toBe(20 * 60_000);
    expect(parseDuration('900s')).toBe(900_000);
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDuration('900')).toBe(900_000);
  });

  it('refuses nonsense with the flag name in the message', () => {
    expect(() => parseDuration('soon')).toThrow(/--timeout/);
    expect(() => parseDuration('20x')).toThrow(/--timeout/);
    expect(() => parseDuration('0')).toThrow(/greater than zero/);
  });
});

describe('flag parsing', () => {
  it('parses issue references in every documented shape', () => {
    expect(parseIssueRef('owner/name#12')).toEqual({ repo: 'owner/name', number: 12 });
    expect(parseIssueRef('https://github.com/owner/name/issues/7')).toEqual({
      repo: 'owner/name',
      number: 7,
    });
    expect(parseIssueRef('42', 'https://github.com/owner/name')).toEqual({ repo: 'owner/name', number: 42 });
    expect(() => parseIssueRef('42')).toThrow(/--repo/);
  });

  it('validates upload levels and exclusions', () => {
    expect(parseUploadLevel('metrics')).toBe('metrics');
    expect(() => parseUploadLevel('everything')).toThrow(/--upload/);
    expect(parseExclusions('diffs, prompts')).toEqual(['diffs', 'prompts']);
    expect(() => parseExclusions('secrets')).toThrow(/--exclude/);
  });
});

describe('server url resolution', () => {
  const base = () => testHarness({ home }).deps;

  it('prefers the flag, then the environment, then config, then localhost', () => {
    const deps = base();
    expect(resolveServerUrl(deps, {}, 'https://flag.example/')).toBe('https://flag.example');
    expect(resolveServerUrl({ ...deps, env: { ARENA_SERVER_URL: 'https://env.example' } }, {})).toBe(
      'https://env.example',
    );
    expect(resolveServerUrl(deps, { serverUrl: 'https://config.example' })).toBe('https://config.example');
    expect(resolveServerUrl(deps, {})).toBe(DEFAULT_SERVER_URL);
  });

  it('refuses a non-http URL', () => {
    expect(() => resolveServerUrl(base(), {}, 'ftp://nope.example')).toThrow(/http/);
  });
});

describe('metric formatting', () => {
  it('shows n/a instead of zero for an unavailable metric', () => {
    expect(formatMetric('tokens_total', { value: null, status: 'unavailable' })).toBe('n/a');
    expect(formatMetric('tokens_total', undefined)).toBe('n/a');
    expect(formatMetric('tokens_total', metric(1234))).toBe('1234');
    expect(formatMetric('duration_ms', metric(65_000))).toBe('65 seconds');
    expect(formatMetric('duration_ms', metric(200_000))).toBe('3.3 minutes');
    expect(formatMetric('cost_usd', metric(0.0421))).toBe('$0.0421');
    expect(formatMetric('cost_usd', { value: 2.5, status: 'estimated', source: 'x' })).toBe('$2.50 (est)');
  });
});

describe('--json output discipline', () => {
  it('sends human lines to stderr and JSON to stdout', () => {
    const t = testHarness({ home });
    const ui = createUi(t.deps, { json: true });
    ui.line('human');
    ui.emitJson({ ok: true });
    expect(t.out()).toBe('{\n  "ok": true\n}\n');
    expect(t.err()).toBe('human\n');
  });

  it('keeps colour out of the output when NO_COLOR is set', () => {
    const t = testHarness({ home, env: { NO_COLOR: '1' }, isTTY: true });
    const ui = createUi(t.deps);
    ui.line(ui.c.green('done'));
    expect(t.out()).toBe('done\n');
  });
});

describe('the lazy uploader', () => {
  function baseUploader(): { uploader: Uploader; calls: string[] } {
    const calls: string[] = [];
    const uploader: Uploader = {
      createBattle: async () => {
        calls.push('create');
        return { id: 'btl_remote', url: 'https://arena.example/b/1', streamUrl: 's' };
      },
      pushEvents: async (_id, events) => {
        calls.push('events:' + String(events.length));
      },
      patchRecord: async () => {
        calls.push('patch');
      },
      uploadArtifact: async () => {
        calls.push('artifact');
      },
      flush: async () => {},
      stats: () => ({ batches: 0, events: 0, artifacts: 0, records: 0, failures: 0, skipped: 0 }),
    };
    return { uploader, calls };
  }

  it('creates the battle from the first record and then flushes the buffered events', async () => {
    const base = baseUploader();
    const { uploader, created } = createLazyUploader(base.uploader);
    const record = fakeRecord({ winner: 'a' });
    const event = { seq: 1 } as unknown as ArenaEvent;

    await uploader.pushEvents(record.id, [event, event]);
    expect(base.calls).toEqual([]);
    expect(created()).toBeNull();

    await uploader.patchRecord(record.id, record);
    expect(base.calls).toEqual(['create', 'events:2', 'patch']);
    expect(created()?.url).toBe('https://arena.example/b/1');

    await uploader.pushEvents(record.id, [event]);
    expect(base.calls).toEqual(['create', 'events:2', 'patch', 'events:1']);
  });

  it('never posts a battle the server already created', async () => {
    const base = baseUploader();
    const known = {
      id: 'btl_pending00000001',
      url: 'https://arena.example/battles/btl_pending00000001',
      streamUrl: 'https://arena.example/api/v1/battles/btl_pending00000001/stream',
    };
    const { uploader, created } = createLazyUploader(base.uploader, known);
    const record = fakeRecord({ winner: 'a', id: known.id });

    // `arena run --battle <id>`: nothing is buffered and no POST /battles is sent.
    await uploader.pushEvents(record.id, [{ seq: 1 } as unknown as ArenaEvent]);
    expect(base.calls).toEqual(['events:1']);
    await uploader.patchRecord(record.id, record);
    expect(base.calls).toEqual(['events:1', 'patch']);
    expect(created()).toEqual(known);
  });

  it('drops buffered events when the battle could not be created', async () => {
    const base = baseUploader();
    const failing: Uploader = { ...base.uploader, createBattle: async () => null };
    const { uploader, created } = createLazyUploader(failing);
    const record = fakeRecord({ winner: 'a' });
    await uploader.pushEvents(record.id, [{ seq: 1 } as unknown as ArenaEvent]);
    await uploader.patchRecord(record.id, record);
    expect(created()).toBeNull();
    expect(base.calls).toEqual([]);
  });
});

describe('device login', () => {
  const codeResponse = {
    deviceCode: 'device-code-long-enough-for-schema',
    userCode: 'WXYZ-1234',
    verificationUri: 'https://arena.example/device',
    verificationUriComplete: 'https://arena.example/device?code=WXYZ-1234',
    expiresIn: 300,
    interval: 1,
  };

  function server(tokenResponses: unknown[]): { fetchImpl: typeof globalThis.fetch; urls: string[] } {
    const urls: string[] = [];
    let index = 0;
    const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/api/v1/device/code')) {
        return new Response(JSON.stringify(codeResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v1/device/token')) {
        const body = tokenResponses[Math.min(index, tokenResponses.length - 1)];
        index += 1;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    return { fetchImpl, urls };
  }

  it('polls until approval, stores the token and never prints it', async () => {
    const approved = {
      status: 'approved',
      token: FAKE_TOKEN,
      tokenPrefix: FAKE_PREFIX,
      user: { id: 'usr_1', login: 'wes', name: 'Wes' },
    };
    const { fetchImpl, urls } = server([{ status: 'pending' }, approved]);
    const t = testHarness({ home, fetchImpl });
    const program = createProgram(t.deps);
    await program.parseAsync([
      'node',
      'arena',
      'login',
      '--server',
      'https://arena.example',
      '--no-browser',
      '--home',
      home,
    ]);

    const config = await t.deps.createStateStore(home).getConfig();
    expect(config.token).toBe(FAKE_TOKEN);
    expect(config.tokenPrefix).toBe(FAKE_PREFIX);
    expect(config.user).toEqual({ id: 'usr_1', login: 'wes', name: 'Wes' });
    expect(config.serverUrl).toBe('https://arena.example');
    expect(t.out()).toContain('WXYZ-1234');
    expect(t.out()).not.toContain(FAKE_TOKEN);
    expect(t.err()).not.toContain(FAKE_TOKEN);
    expect(urls.filter((url) => url.endsWith('/device/token'))).toHaveLength(2);
    expect(t.opened).toHaveLength(0);
  });

  it('opens the browser at the complete verification URL unless --no-browser', async () => {
    const approved = {
      status: 'approved',
      token: FAKE_TOKEN,
      tokenPrefix: FAKE_PREFIX,
      user: { id: 'usr_1', login: 'wes', name: null },
    };
    const { fetchImpl } = server([approved]);
    const t = testHarness({ home, fetchImpl });
    await createProgram(t.deps).parseAsync([
      'node',
      'arena',
      'login',
      '--server',
      'https://arena.example',
      '--home',
      home,
    ]);
    expect(t.opened).toEqual(['https://arena.example/device?code=WXYZ-1234']);
  });

  it('reports a denied and an expired login', async () => {
    for (const status of ['denied', 'expired'] as const) {
      const { fetchImpl } = server([{ status }]);
      const t = testHarness({ home, fetchImpl });
      await expect(
        createProgram(t.deps).parseAsync([
          'node',
          'arena',
          'login',
          '--server',
          'https://arena.example',
          '--no-browser',
          '--home',
          home,
        ]),
      ).rejects.toThrow(status === 'denied' ? /denied/ : /expired/);
      const config = await t.deps.createStateStore(home).getConfig();
      expect(config.token).toBeUndefined();
    }
  });

  it('logout clears the token and whoami needs one', async () => {
    const t = testHarness({ home });
    await t.deps.createStateStore(home).setConfig({ token: FAKE_TOKEN, tokenPrefix: FAKE_PREFIX });
    await createProgram(t.deps).parseAsync(['node', 'arena', 'logout', '--json', '--home', home]);
    expect((await t.deps.createStateStore(home).getConfig()).token).toBeNull();
    expect(t.fetches.at(-1)?.method).toBe('DELETE');

    const t2 = testHarness({ home });
    await expect(
      createProgram(t2.deps).parseAsync(['node', 'arena', 'whoami', '--home', home]),
    ).rejects.toThrow(/arena login/);
  });

  it('backs off on a rate-limited poll instead of failing, and clamps the wait', async () => {
    const approved = {
      status: 'approved',
      token: FAKE_TOKEN,
      tokenPrefix: FAKE_PREFIX,
      user: { id: 'usr_1', login: 'wes', name: null },
    };
    for (const [retryAfter, expected] of [
      ['2', 2_000],
      ['999999', 30_000],
    ] as const) {
      const pollHome = tempDir('login-429');
      try {
        let polls = 0;
        const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
          if (String(input).endsWith('/api/v1/device/code')) {
            return new Response(JSON.stringify(codeResponse), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          polls += 1;
          if (polls === 1) {
            return new Response(
              JSON.stringify({
                error: { code: 'rate_limited', message: 'too many requests; retry in ' + retryAfter + 's' },
              }),
              {
                status: 429,
                headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
              },
            );
          }
          return new Response(JSON.stringify(approved), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof globalThis.fetch;

        const t = testHarness({ home: pollHome, fetchImpl });
        const sleeps: number[] = [];
        await createProgram({
          ...t.deps,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        }).parseAsync([
          'node',
          'arena',
          'login',
          '--server',
          'https://arena.example',
          '--no-browser',
          '--home',
          pollHome,
        ]);

        expect(polls).toBe(2);
        expect((await t.deps.createStateStore(pollHome).getConfig()).token).toBe(FAKE_TOKEN);
        // retry-after is honoured, never unclamped: a huge value cannot park the CLI.
        expect(Math.max(...sleeps)).toBe(expected);
      } finally {
        removeDir(pollHome);
      }
    }
  });

  it('describes how the token file is protected on this platform', async () => {
    const approved = {
      status: 'approved',
      token: FAKE_TOKEN,
      tokenPrefix: FAKE_PREFIX,
      user: { id: 'usr_1', login: 'wes', name: null },
    };
    for (const platform of ['win32', 'linux'] as const) {
      const platformHome = tempDir('login-mode');
      try {
        const { fetchImpl } = server([approved]);
        const t = testHarness({ home: platformHome, fetchImpl, platform });
        await createProgram(t.deps).parseAsync([
          'node',
          'arena',
          'login',
          '--server',
          'https://arena.example',
          '--no-browser',
          '--home',
          platformHome,
        ]);
        if (platform === 'win32') {
          // chmod 0600 is a no-op on Windows, so the CLI must not claim it.
          expect(t.out()).toContain('protected by the permissions of your user profile directory');
          expect(t.out()).not.toContain('0600');
        } else {
          expect(t.out()).toContain('mode 0600');
        }
        expect(t.out()).not.toContain(FAKE_TOKEN);
      } finally {
        removeDir(platformHome);
      }
    }
  });

  it('names the device without a hostname', () => {
    expect(deviceName('win32')).toBe('arena-cli on win32');
    expect(deviceName('linux')).toBe('arena-cli on linux');
  });
});

describe('flag help text', () => {
  it('--local-only promises no upload, not that the server is never contacted', () => {
    // `arena run --battle <id> --local-only` fetches the spec with the device token first.
    const t = testHarness({ home });
    const program = createProgram(t.deps);
    for (const name of ['battle', 'run']) {
      const help = program.commands.find((command) => command.name() === name)?.helpInformation() ?? '';
      expect(help, name).toContain('--local-only');
      expect(help, name).toContain('never upload');
      expect(help, name).not.toContain('never contact the server');
    }
  });
});

describe('regression aggregation', () => {
  interface SideFixture {
    status?: 'completed' | 'failed';
    passed?: number;
    failed?: number;
    tokens?: number;
    duration?: number;
  }

  function row(name: string, baseline: SideFixture, candidate: SideFixture) {
    const record: BattleRecord = fakeRecord({
      statusA: baseline.status ?? 'completed',
      statusB: candidate.status ?? 'completed',
      durationA: baseline.duration ?? 100_000,
      durationB: candidate.duration ?? 100_000,
      metricsA: {
        ...(baseline.passed === undefined ? {} : { tests_passed: metric(baseline.passed) }),
        ...(baseline.failed === undefined ? {} : { tests_failed: metric(baseline.failed) }),
        ...(baseline.tokens === undefined ? {} : { tokens_total: metric(baseline.tokens) }),
      },
      metricsB: {
        ...(candidate.passed === undefined ? {} : { tests_passed: metric(candidate.passed) }),
        ...(candidate.failed === undefined ? {} : { tests_failed: metric(candidate.failed) }),
        ...(candidate.tokens === undefined ? {} : { tokens_total: metric(candidate.tokens) }),
      },
      winner: 'b',
    });
    return rowFromRecord(name, record);
  }

  it('counts completion, token and duration deltas', () => {
    const rows = [
      row(
        'one.json',
        { passed: 10, failed: 0, tokens: 1000, duration: 100_000 },
        { passed: 10, failed: 0, tokens: 800, duration: 90_000 },
      ),
      row(
        'two.json',
        { passed: 8, failed: 2, tokens: 1000, duration: 100_000 },
        { passed: 9, failed: 1, tokens: 850, duration: 95_000 },
      ),
    ];
    const summary = summarizeRegression(rows);
    expect(summary.battles).toBe(2);
    expect(summary.baselineCompleted).toBe(2);
    expect(summary.candidateCompleted).toBe(2);
    expect(summary.completionDeltaPercent).toBe(0);
    expect(summary.tokensDeltaPercent).toBe(-17);
    expect(summary.durationDeltaPercent).toBe(-7);
    expect(summary.regressions).toBe(0);
    expect(summary.failed).toBe(false);
    expect(headlineLine(summary)).toBe(
      'Completion 0 percent / Tokens -17 percent / Duration -7 percent / Regressions none',
    );
  });

  it('flags a candidate that fails a battle the baseline completed', () => {
    const rows = [
      row('one.json', { passed: 5, failed: 0 }, { status: 'failed', passed: 0, failed: 5 }),
      row('two.json', { passed: 5, failed: 0 }, { passed: 5, failed: 0 }),
    ];
    const summary = summarizeRegression(rows);
    expect(summary.candidateCompleted).toBe(1);
    expect(summary.completionDeltaPercent).toBe(-50);
    expect(summary.regressions).toBe(1);
    expect(summary.failed).toBe(true);
    expect(rows[0]?.reasons.join(' ')).toMatch(/did not complete/);
  });

  it('reports n/a rather than a fabricated delta when tokens are unavailable', () => {
    const rows = [row('one.json', {}, {})];
    const summary = summarizeRegression(rows);
    expect(summary.tokensDeltaPercent).toBeNull();
    expect(headlineLine(summary)).toContain('Tokens n/a');
  });

  it('writes a Markdown table for a GitHub check', () => {
    const rows = [
      row('one.json', { passed: 3, failed: 0, tokens: 100 }, { passed: 3, failed: 0, tokens: 90 }),
    ];
    const markdown = regressionMarkdown(rows, summarizeRegression(rows), {
      baseline: 'vanilla',
      candidate: './my-harness',
    });
    expect(markdown).toContain('## Harness regression: ./my-harness vs vanilla');
    expect(markdown).toContain('| one.json |');
    expect(markdown.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(3);
  });
});

describe('arena regression end to end', () => {
  it('runs every spec in the directory with baseline and candidate and exits 1 on a regression', async () => {
    const dir = path.join(home, 'specs');
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      version: 1,
      task: { kind: 'prompt', prompt: 'do it' },
      repository: { source: 'empty' },
      competitors: {
        a: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
        b: { agent: { id: 'fake' }, harness: { source: 'vanilla' } },
      },
      privacy: { upload: 'full' },
    };
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(spec));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(spec));

    const record = fakeRecord({
      statusA: 'completed',
      statusB: 'failed',
      metricsA: { tests_passed: metric(4), tests_failed: metric(0) },
      metricsB: { tests_passed: metric(1), tests_failed: metric(3) },
      winner: 'a',
    });
    const t = testHarness({ home, record, adapters: [stubAdapter({ id: 'fake' })] });
    const markdown = path.join(home, 'regression.md');

    await expect(
      createProgram(t.deps).parseAsync([
        'node',
        'arena',
        'regression',
        dir,
        '--baseline',
        'vanilla',
        '--candidate',
        './candidate',
        '--agent',
        'fake',
        '--markdown',
        markdown,
        '--json',
        '--home',
        home,
      ]),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(t.specs).toHaveLength(2);
    expect(t.specs[0]?.competitors.a.harness.source).toBe('vanilla');
    expect(t.specs[0]?.competitors.b.harness.source).toBe('./candidate');
    expect(t.specs[0]?.competitors.a.label).toBe('baseline');
    expect(t.specs[0]?.competitors.b.label).toBe('candidate');
    // A regression run never uploads, whatever the spec said.
    expect(t.specs[0]?.privacy?.upload).toBe('none');
    expect(fs.existsSync(markdown)).toBe(true);
    expect(fs.readFileSync(markdown, 'utf8')).toContain('Regressions 2');
  });
});

describe('demo export rewriting', () => {
  it('replaces every spelling of ARENA_HOME with ~/.harness-arena', () => {
    const windowsHome = 'C:\\Users\\someone\\.harness-arena';
    const text = JSON.stringify({
      a: windowsHome + '\\battles\\btl_1',
      b: 'C:/Users/someone/.harness-arena/battles/btl_1',
    });
    const rewritten = rewriteHome(text, windowsHome, 'win32');
    expect(rewritten).not.toContain('someone');
    expect(rewritten).toContain('~/.harness-arena');
  });

  it('leaves unrelated paths alone', () => {
    const rewritten = rewriteHome('/home/other/project', '/home/user/.harness-arena', 'linux');
    expect(rewritten).toBe('/home/other/project');
  });
});
