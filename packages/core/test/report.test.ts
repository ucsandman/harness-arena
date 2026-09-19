import { describe, expect, it } from 'vitest';
import { battleSpecSchema, calculated, emptyMetrics, observed, unavailable } from '@harness-arena/protocol';
import type { ArenaEvent } from '@harness-arena/protocol';
import { buildReportBundle, renderReportHtml, stripAnsi } from '../src/report/html.js';
import { fakeVerdict, makeEvent, makeRecord } from './helpers.js';

const XSS = '<script>alert("pwn")</script>';
const CLOSER = '</script><img src=x onerror=alert(1)>';

const SPEC = battleSpecSchema.parse({
  version: 1,
  title: 'Battle ' + XSS,
  task: { kind: 'prompt', prompt: 'Fix it ' + XSS },
  repository: { source: 'empty' },
  competitors: {
    a: { label: 'A ' + XSS, agent: { id: 'fake' }, harness: { source: 'vanilla' } },
    b: { label: 'B', agent: { id: 'fake' }, harness: { source: 'vanilla' } },
  },
});

function hostileRecord() {
  const metricsA = emptyMetrics();
  metricsA.duration_ms = calculated(65_000, 'core:clock');
  metricsA.tests_passed = calculated(3, 'core:tests');
  metricsA.cost_usd = observed(0.1234, 'fake:usage');
  metricsA.files_changed = calculated(2, 'core:git-diff');
  const metricsB = emptyMetrics();
  metricsB.duration_ms = calculated(30_000, 'core:clock');
  metricsB.tests_passed = calculated(1, 'core:tests');
  metricsB.cost_usd = unavailable('cost is not reported by codex');
  metricsB.files_changed = calculated(9, 'core:git-diff');

  return makeRecord({
    spec: SPEC,
    a: {
      label: 'A ' + XSS,
      metrics: metricsA,
      artifacts: {
        diff: [
          'diff --git a/src/auth/session.js b/src/auth/session.js',
          'index 1111111..2222222 100644',
          '--- a/src/auth/session.js',
          '+++ b/src/auth/session.js',
          '@@ -1,3 +1,3 @@',
          '-  return expiresAt < Date.now();',
          '+  return expiresAt * 1000 < Date.now();',
          ' // ' + CLOSER,
        ].join('\n'),
        diffBytes: 220,
        finalResponse: 'fixed ' + XSS,
        changedFiles: [{ path: 'src/auth/session.js', kind: 'modify', linesAdded: 1, linesRemoved: 1 }],
      },
      error: { code: 'tool_error', message: 'failed ' + XSS },
    },
    b: { metrics: metricsB },
    record: {
      demo: true,
      verdict: { ...fakeVerdict('a'), caveats: ['caveat ' + XSS] },
      insights: [
        {
          id: 'x',
          kind: 'timing',
          text: 'insight ' + XSS,
          favors: 'a',
          support: { metrics: ['duration_ms'], eventSeqs: [1] },
        },
      ],
      error: 'battle failed ' + XSS,
    },
  });
}

const EVENTS: ArenaEvent[] = [
  makeEvent(
    'agent.output',
    { role: 'assistant', text: 'hello \u001B[31mred\u001B[0m ' + XSS },
    { seq: 1, tOffsetMs: 0 },
  ),
  makeEvent('tool.called', { toolId: 't1', name: 'Bash' }, { seq: 2, side: 'b', tOffsetMs: 500 }),
];

describe('renderReportHtml', () => {
  const record = hostileRecord();
  const html = renderReportHtml(buildReportBundle(record, EVENTS, '0.1.0-test'));

  it('renders one self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<style>');
    expect(html.length).toBeGreaterThan(4000);
  });

  it('never emits raw script or img tags from battle data', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain(CLOSER);
    expect(html).toContain('&lt;script&gt;alert');
  });

  it('escapes the closing script sequence inside the embedded JSON', () => {
    const start = html.indexOf('<script id="arena-bundle" type="application/json">');
    const json = html.slice(start + '<script id="arena-bundle" type="application/json">'.length);
    const end = json.indexOf('</script>');
    const body = json.slice(0, end);
    expect(body).not.toContain('</script');
    expect(body).toContain('\\u003c');
    const parsed = JSON.parse(body) as { record: { id: string }; events: unknown[] };
    expect(parsed.record.id).toBe(record.id);
    expect(parsed.events).toHaveLength(2);
  });

  it('makes no external requests', () => {
    expect(html).not.toContain('<link');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('@import');
    expect(html).not.toContain('url(http');
    expect(html).not.toContain('<iframe');
    // the only <script> tags are the inline bundle and the inline viewer
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('strips ANSI escapes from the data it embeds', () => {
    expect(html).not.toContain('\u001B[31m');
    expect(stripAnsi('a\u001B[31mb\u001B[0m')).toBe('ab');
  });

  it('shows the verdict, the demo badge and the timeline controls', () => {
    expect(html).toContain('demo data');
    expect(html).toContain('wins');
    expect(html).toContain('confidence <strong>60%</strong>');
    expect(html).toContain('id="scrub"');
    expect(html).toContain('id="cursor-a"');
    expect(html).toContain('id="log-b"');
    expect(html).toContain('id="filter-a"');
  });

  it('labels every metric with its status and never fakes a zero', () => {
    expect(html).toContain('badge calculated');
    expect(html).toContain('badge observed');
    expect(html).toContain('badge unavailable');
    expect(html).toContain('>n/a<');
    expect(html).toContain('cost is not reported by codex');
    // 65 s duration rendered for humans, not as raw ms
    expect(html).toContain('1m 05s');
  });

  it('colours the diff and lists the changed file', () => {
    expect(html).toContain('class="line add"');
    expect(html).toContain('class="line del"');
    expect(html).toContain('class="line hunk"');
    expect(html).toContain('src/auth/session.js');
  });

  it('discloses what was executed without leaking env values', () => {
    expect(html).toContain('fake-agent --headless');
    expect(html).toContain('ARENA_FAKE');
    expect(html).toContain('values never recorded');
  });

  it('renders the environment block', () => {
    expect(html).toContain('Environment and reproducibility');
    expect(html).toContain('v24.0.0');
    expect(html).toContain('2.45.0');
  });

  it('renders a record with no verdict, no diff and no events', () => {
    const bare = makeRecord({ spec: SPEC, record: { status: 'failed' } });
    const out = renderReportHtml(buildReportBundle(bare, [], '0.1.0-test'));
    expect(out).toContain('No verdict');
    expect(out).toContain('The diff was not captured');
    expect(out).toContain('No errors were recorded.');
  });
});
