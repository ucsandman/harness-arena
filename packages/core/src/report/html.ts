import { METRIC_DIRECTION, METRIC_KEYS, METRIC_LABELS } from '@harness-arena/protocol';
import type {
  ArenaEvent,
  BattleRecord,
  Insight,
  MetricKey,
  MetricValue,
  ReportBundle,
  RunRecord,
  Side,
} from '@harness-arena/protocol';

/**
 * The local battle report: ONE HTML file, no external requests, readable offline.
 *
 * Safety rules that are not negotiable here:
 *  - every piece of battle data reaches the DOM through escapeHtml() (server side) or textContent
 *    (client side). There is no innerHTML with data anywhere.
 *  - ANSI escape sequences are stripped before anything is embedded.
 *  - the embedded JSON escapes `<` so a payload containing `</script>` cannot close the tag.
 */

const SIDES: readonly Side[] = ['a', 'b'];

// CSI / OSC sequences emitted by test runners and CLIs; matching them needs the control chars.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripAnsiDeep<T>(value: T): T {
  if (typeof value === 'string') return stripAnsi(value) as unknown as T;
  if (Array.isArray(value)) return value.map(stripAnsiDeep) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripAnsiDeep(v);
    return out as unknown as T;
  }
  return value;
}

export function buildReportBundle(
  record: BattleRecord,
  events: readonly ArenaEvent[],
  arenaVersion: string,
): ReportBundle {
  return {
    record: stripAnsiDeep(record),
    events: stripAnsiDeep([...events]) as unknown[],
    generatedAt: new Date().toISOString(),
    arenaVersion,
  };
}

/** `<` can only appear inside a JSON string, so escaping it keeps the JSON valid and the tag closed. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function statusBadge(status: MetricValue['status']): string {
  const text = status === 'unavailable' ? 'n/a' : status;
  return '<span class="badge ' + status + '">' + escapeHtml(text) + '</span>';
}

function formatMetricValue(key: MetricKey, metric: MetricValue): string {
  if (metric.status === 'unavailable' || metric.value === null) return 'n/a';
  if (typeof metric.value === 'number') {
    if (key === 'duration_ms') return formatDuration(metric.value);
    if (key === 'cost_usd') return '$' + metric.value.toFixed(metric.value < 1 ? 4 : 2);
    return metric.value.toLocaleString('en-US');
  }
  return String(metric.value);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60_000) return (Math.round(ms / 100) / 10).toFixed(1) + ' s';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
}

function betterSide(key: MetricKey, a: MetricValue, b: MetricValue): Side | null {
  const direction = METRIC_DIRECTION[key];
  if (direction === 'none') return null;
  if (a.status === 'unavailable' || b.status === 'unavailable') return null;
  if (typeof a.value !== 'number' || typeof b.value !== 'number' || a.value === b.value) return null;
  const lowerWins = direction === 'lower';
  return (lowerWins ? a.value < b.value : a.value > b.value) ? 'a' : 'b';
}

function metricRows(record: BattleRecord): string {
  const rows: string[] = [];
  for (const key of METRIC_KEYS) {
    const a = record.runs.a.metrics[key];
    const b = record.runs.b.metrics[key];
    const winner = betterSide(key, a, b);
    const cell = (side: Side, metric: MetricValue) =>
      '<td class="value' +
      (winner === side ? ' better' : '') +
      '"' +
      (metric.note ? ' title="' + escapeHtml(metric.note) + '"' : '') +
      '>' +
      '<span class="num">' +
      escapeHtml(formatMetricValue(key, metric)) +
      '</span> ' +
      statusBadge(metric.status) +
      (metric.note ? '<div class="note">' + escapeHtml(metric.note) + '</div>' : '') +
      '</td>';
    rows.push(
      '<tr><th scope="row">' +
        escapeHtml(METRIC_LABELS[key]) +
        '</th>' +
        cell('a', a) +
        cell('b', b) +
        '</tr>',
    );
  }
  return rows.join('\n');
}

function verdictSection(record: BattleRecord): string {
  const verdict = record.verdict;
  if (!verdict) return '<p class="muted">No verdict: the battle did not reach evaluation.</p>';
  const list = (title: string, items: string[]) =>
    items.length === 0
      ? ''
      : '<h4>' +
        escapeHtml(title) +
        '</h4><ul>' +
        items.map((i) => '<li>' + escapeHtml(i) + '</li>').join('') +
        '</ul>';
  return (
    '<p class="verdict-line">Method <strong>' +
    escapeHtml(verdict.method) +
    '</strong>, confidence <strong>' +
    Math.round(verdict.confidence * 100) +
    '%</strong>.</p>' +
    list('Reasons', verdict.reasons) +
    list('Decisive factors', verdict.decisiveFactors) +
    list('Caveats', verdict.caveats) +
    (verdict.judge
      ? '<p class="judge">Blind LLM judge (subjective, labelled): <strong>' +
        escapeHtml(verdict.judge.winner) +
        '</strong> — ' +
        escapeHtml(verdict.judge.rationale) +
        '</p>'
      : '')
  );
}

function insightsSection(insights: Insight[]): string {
  if (insights.length === 0)
    return '<p class="muted">No insight is supported by this battle&#39;s telemetry.</p>';
  return (
    '<ul class="insights">' +
    insights
      .map(
        (i) =>
          '<li class="insight ' +
          escapeHtml(i.kind) +
          '"><span class="tag">' +
          escapeHtml(i.kind) +
          '</span> ' +
          escapeHtml(i.text) +
          (i.support.eventSeqs.length > 0
            ? '<span class="muted"> (events ' + escapeHtml(i.support.eventSeqs.join(', ')) + ')</span>'
            : '') +
          '</li>',
      )
      .join('') +
    '</ul>'
  );
}

function splitDiff(diff: string): Array<{ path: string; body: string }> {
  if (!diff.trim()) return [];
  const parts = diff.split(/^diff --git /m).filter((p) => p.trim().length > 0);
  if (parts.length === 0) return [{ path: '(patch)', body: diff }];
  return parts.map((part) => {
    const firstLine = part.split('\n', 1)[0] ?? '';
    const match = /b\/(.+)$/.exec(firstLine.trim());
    return { path: match ? (match[1] as string) : firstLine.trim() || '(file)', body: 'diff --git ' + part };
  });
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('Binary files'))
    return 'meta';
  return '';
}

function diffSection(run: RunRecord): string {
  const diff = run.artifacts.diff;
  if (diff === null || diff === undefined) {
    return '<p class="muted">The diff was not captured (privacy settings exclude diffs, or the run produced none).</p>';
  }
  const files = splitDiff(diff);
  if (files.length === 0) return '<p class="muted">No changes.</p>';
  const changed = new Map(run.artifacts.changedFiles.map((f) => [f.path, f]));
  return files
    .map((file) => {
      const stat = changed.get(file.path);
      const head =
        '<div class="diff-head"><span class="path">' +
        escapeHtml(file.path) +
        '</span>' +
        (stat
          ? '<span class="stat"><span class="add">+' +
            stat.linesAdded +
            '</span> <span class="del">-' +
            stat.linesRemoved +
            '</span> ' +
            escapeHtml(stat.kind) +
            '</span>'
          : '') +
        '</div>';
      const body = file.body
        .split('\n')
        .map((line) => {
          const cls = diffLineClass(line);
          return '<span class="line ' + cls + '">' + escapeHtml(line) + '</span>';
        })
        .join('\n');
      return (
        '<details class="diff-file" open>' +
        '<summary>' +
        head +
        '</summary><pre class="diff">' +
        body +
        '</pre></details>'
      );
    })
    .join('\n');
}

function testsSection(record: BattleRecord): string {
  const cells = SIDES.map((side) => {
    const run = record.runs[side];
    const passed = run.metrics.tests_passed;
    const failed = run.metrics.tests_failed;
    const total = run.metrics.tests_total;
    const regressions = run.metrics.regressions;
    return (
      '<div class="card"><h4>' +
      escapeHtml(run.label) +
      '</h4><table class="kv">' +
      ['tests_passed', 'tests_failed', 'tests_total', 'regressions']
        .map((key) => {
          const metric = { tests_passed: passed, tests_failed: failed, tests_total: total, regressions }[
            key
          ] as MetricValue;
          return (
            '<tr><th>' +
            escapeHtml(METRIC_LABELS[key as MetricKey]) +
            '</th><td>' +
            escapeHtml(formatMetricValue(key as MetricKey, metric)) +
            ' ' +
            statusBadge(metric.status) +
            '</td></tr>'
          );
        })
        .join('') +
      '</table></div>'
    );
  });
  return '<div class="grid2">' + cells.join('') + '</div>';
}

function errorsSection(record: BattleRecord): string {
  const items: string[] = [];
  if (record.error) items.push('Battle: ' + record.error);
  for (const side of SIDES) {
    const err = record.runs[side].error;
    if (err) items.push(record.runs[side].label + ' (' + err.code + '): ' + err.message);
  }
  if (items.length === 0) return '<p class="muted">No errors were recorded.</p>';
  return '<ul class="errors">' + items.map((i) => '<li>' + escapeHtml(i) + '</li>').join('') + '</ul>';
}

function environmentSection(record: BattleRecord, bundle: ReportBundle): string {
  const env = record.environment;
  const rows: Array<[string, string]> = [
    ['Arena version', env.arenaVersion],
    ['Protocol version', String(record.protocolVersion)],
    ['Platform', env.os.platform + ' ' + env.os.release + ' (' + env.os.arch + ')'],
    ['Node', env.node],
    ['Git', env.git ?? 'not found'],
    ['CPU cores', String(env.cpuCount)],
    ['Memory', env.memoryGb + ' GB'],
    ['CI', env.ci ? 'yes' : 'no'],
    ['Repository', record.repository.source + ' (' + record.repository.kind + ')'],
    ['Commit', record.repository.commit ?? 'n/a'],
    ['Dirty checkout', record.repository.dirty === null ? 'n/a' : record.repository.dirty ? 'yes' : 'no'],
    [
      'Verification',
      record.verification.kind + (record.verification.eligible ? ', rating-eligible' : ', self-reported'),
    ],
    ['Report generated', bundle.generatedAt],
  ];
  for (const [id, info] of Object.entries(env.agents)) {
    rows.push([
      'Agent ' + id,
      (info.version ?? 'unknown version') +
        ', user config ' +
        (info.userConfigIsolated === null
          ? 'isolation unknown'
          : info.userConfigIsolated
            ? 'excluded'
            : 'NOT excluded'),
    ]);
  }
  for (const [agent, flags] of Object.entries(env.sharedFlags)) {
    rows.push(['Shared flags (' + agent + ')', flags.join(' ')]);
  }
  return (
    '<table class="kv">' +
    rows.map(([k, v]) => '<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(v) + '</td></tr>').join('') +
    '</table>'
  );
}

function invocationSection(record: BattleRecord): string {
  return (
    '<div class="grid2">' +
    SIDES.map((side) => {
      const run = record.runs[side];
      const inv = run.invocation;
      return (
        '<div class="card"><h4>' +
        escapeHtml(run.label) +
        '</h4>' +
        (inv
          ? '<pre class="inv">' +
            escapeHtml([inv.command, ...inv.args].join(' ')) +
            '</pre><p class="muted">Prompt delivered on stdin. Environment keys added: ' +
            escapeHtml(inv.envKeys.length > 0 ? inv.envKeys.join(', ') : 'none') +
            ' (values never recorded).</p>'
          : '<p class="muted">The run never reached execution.</p>') +
        '<table class="kv"><tr><th>Harness</th><td>' +
        escapeHtml(run.harness.name + ' (' + run.harness.kind + ')') +
        '</td></tr><tr><th>Harness source</th><td>' +
        escapeHtml(run.harness.source) +
        '</td></tr><tr><th>Harness commit</th><td>' +
        escapeHtml(run.harness.commit ?? 'n/a') +
        '</td></tr><tr><th>Applied files</th><td>' +
        escapeHtml(run.harness.appliedFiles.length > 0 ? run.harness.appliedFiles.join(', ') : 'none') +
        '</td></tr><tr><th>Executed commands</th><td>' +
        escapeHtml(
          run.harness.executedCommands.length > 0 ? run.harness.executedCommands.join(' && ') : 'none',
        ) +
        '</td></tr><tr><th>Model</th><td>' +
        escapeHtml(run.agent.model ?? 'agent default') +
        '</td></tr></table></div>'
      );
    }).join('') +
    '</div>'
  );
}

const CSS = `
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#e6edf3;--muted:#8b949e;
--a:#58a6ff;--b:#f778ba;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,Cantarell,"Helvetica Neue",Arial,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 20px 80px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:0 0 12px}h3{font-size:15px;margin:0 0 8px}h4{font-size:13px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;margin:16px 0}
.muted{color:var(--muted)}
.head-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
.winner{font-size:20px;font-weight:600}
.pill{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted)}
.pill.demo{border-color:var(--warn);color:var(--warn)}
.side-a{color:var(--a)}.side-b{color:var(--b)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th[scope=row]{color:var(--muted);font-weight:500;width:26%}
table.kv th{color:var(--muted);font-weight:500;width:38%}
td.value{width:37%}
td.value.better .num{color:var(--ok);font-weight:600}
.num{font-variant-numeric:tabular-nums}
.note{color:var(--muted);font-size:12px;margin-top:2px}
.badge{font-size:10px;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--line);border-radius:4px;padding:1px 4px;color:var(--muted)}
.badge.observed{border-color:var(--ok);color:var(--ok)}
.badge.calculated{border-color:var(--a);color:var(--a)}
.badge.estimated{border-color:var(--warn);color:var(--warn)}
.badge.unavailable{border-color:var(--line);color:var(--muted)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:820px){.grid2{grid-template-columns:1fr}}
.card{background:#0f141b;border:1px solid var(--line);border-radius:8px;padding:12px}
ul{margin:4px 0 12px;padding-left:20px}
.insights{list-style:none;padding:0}
.insight{border-left:3px solid var(--line);padding:6px 10px;margin:6px 0;background:#0f141b}
.insight.warning{border-left-color:var(--warn)}
.insight.timing{border-left-color:var(--a)}
.insight.efficiency{border-left-color:var(--ok)}
.tag{font-size:10px;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:1px 4px;margin-right:6px}
pre{margin:0;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f141b;border:1px solid var(--line);border-radius:6px;padding:10px;max-height:460px}
pre.diff .line{display:block;white-space:pre-wrap}
pre.diff .add{color:var(--ok)}pre.diff .del{color:var(--bad)}pre.diff .hunk{color:var(--a)}pre.diff .meta{color:var(--muted)}
.diff-file{border:1px solid var(--line);border-radius:8px;margin:10px 0;overflow:hidden}
.diff-file summary{cursor:pointer;padding:8px 10px;background:#0f141b}
.diff-head{display:inline-flex;gap:10px;align-items:baseline}
.diff-head .path{font:12px ui-monospace,Consolas,monospace}
.stat{font-size:12px;color:var(--muted)}.stat .add{color:var(--ok)}.stat .del{color:var(--bad)}
.timeline{position:relative;margin:10px 0}
.lane{position:relative;height:30px;border:1px solid var(--line);border-radius:6px;background:#0f141b;margin:6px 0}
.lane .tick{position:absolute;top:4px;width:3px;height:20px;border-radius:2px;background:var(--muted);opacity:.25}
.lane .tick.on{opacity:1}
.lane.a .tick.on{background:var(--a)}.lane.b .tick.on{background:var(--b)}
.lane .tick.err{background:var(--bad)}
input[type=range]{width:100%}
.cursor-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:8px;font-size:12px}
.evlog{max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:6px;background:#0f141b}
.evrow{display:grid;grid-template-columns:54px 70px 1fr;gap:8px;padding:3px 8px;border-bottom:1px solid #21262d;font:12px/1.4 ui-monospace,Consolas,monospace}
.evrow .t{color:var(--muted)}.evrow .ty{color:var(--a)}
.controls{display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
select,button{background:#0f141b;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:inherit}
footer{color:var(--muted);font-size:12px;text-align:center;padding:20px}
`;

const SCRIPT = `
(function(){
  var node = document.getElementById('arena-bundle');
  if (!node) return;
  var bundle;
  try { bundle = JSON.parse(node.textContent || '{}'); } catch (e) { return; }
  var events = Array.isArray(bundle.events) ? bundle.events : [];
  var record = bundle.record || {};
  var labels = {
    a: (record.runs && record.runs.a && record.runs.a.label) || 'A',
    b: (record.runs && record.runs.b && record.runs.b.label) || 'B'
  };
  var maxT = 0;
  for (var i = 0; i < events.length; i++) maxT = Math.max(maxT, events[i].tOffsetMs || 0);
  if (maxT <= 0) maxT = 1;

  function summarise(ev) {
    var p = ev.payload || {};
    if (ev.type === 'tool.called') return String(p.name || '');
    if (ev.type === 'tool.result') return String(p.name || '') + (p.ok ? ' ok' : ' failed');
    if (ev.type === 'command.started') return String(p.command || '');
    if (ev.type === 'command.completed') return 'exit ' + String(p.exitCode);
    if (ev.type === 'file.read') return String(p.path || '');
    if (ev.type === 'file.changed') return String(p.kind || '') + ' ' + String(p.path || '');
    if (ev.type === 'agent.output') return String(p.role || '') + ': ' + String(p.text || '').slice(0, 160);
    if (ev.type === 'test.completed') return String(p.phase) + ' passed=' + String(p.passed) + ' failed=' + String(p.failed);
    if (ev.type === 'run.completed') return String(p.status) + ' exit ' + String(p.exitCode);
    if (ev.type === 'error' || ev.type === 'warning') return String(p.message || '').slice(0, 200);
    if (ev.type === 'limit.hit') return String(p.kind || '');
    if (ev.type === 'subagent.spawned') return String(p.name || p.subagentId || '');
    return '';
  }

  var ticks = { a: [], b: [] };
  ['a', 'b'].forEach(function (side) {
    var lane = document.querySelector('.lane.' + side);
    if (!lane) return;
    events.forEach(function (ev) {
      if (ev.side !== side) return;
      var tick = document.createElement('span');
      tick.className = 'tick' + (ev.type === 'error' ? ' err' : '');
      tick.style.left = ((ev.tOffsetMs || 0) / maxT * 99) + '%';
      tick.title = '#' + ev.seq + ' ' + ev.type;
      lane.appendChild(tick);
      ticks[side].push({ el: tick, t: ev.tOffsetMs || 0, ev: ev });
    });
  });

  var slider = document.getElementById('scrub');
  if (slider) {
    slider.max = String(maxT);
    slider.value = String(maxT);
  }
  var clockEl = document.getElementById('scrub-clock');

  function render(cursor) {
    if (clockEl) clockEl.textContent = (cursor / 1000).toFixed(1) + ' s of ' + (maxT / 1000).toFixed(1) + ' s';
    ['a', 'b'].forEach(function (side) {
      var current = null;
      for (var i = 0; i < ticks[side].length; i++) {
        var entry = ticks[side][i];
        var on = entry.t <= cursor;
        entry.el.classList.toggle('on', on);
        if (on) current = entry.ev;
      }
      var out = document.getElementById('cursor-' + side);
      if (!out) return;
      out.textContent = current
        ? '#' + current.seq + '  ' + current.type + (summarise(current) ? '  ' + summarise(current) : '')
        : 'nothing yet';
    });
  }

  if (slider) slider.addEventListener('input', function () { render(Number(slider.value)); });
  render(maxT);

  var types = [];
  events.forEach(function (ev) { if (types.indexOf(ev.type) === -1) types.push(ev.type); });
  types.sort();

  ['a', 'b'].forEach(function (side) {
    var list = document.getElementById('log-' + side);
    var filter = document.getElementById('filter-' + side);
    var head = document.getElementById('log-head-' + side);
    if (head) head.textContent = labels[side];
    if (!list || !filter) return;
    types.forEach(function (type) {
      var option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      filter.appendChild(option);
    });
    function draw() {
      var want = filter.value;
      list.textContent = '';
      var shown = 0;
      events.forEach(function (ev) {
        if (ev.side !== side) return;
        if (want !== '*' && ev.type !== want) return;
        shown++;
        var row = document.createElement('div');
        row.className = 'evrow';
        var seq = document.createElement('span');
        seq.className = 't';
        seq.textContent = '#' + ev.seq;
        var time = document.createElement('span');
        time.className = 't';
        time.textContent = '+' + ((ev.tOffsetMs || 0) / 1000).toFixed(1) + 's';
        var body = document.createElement('span');
        var type = document.createElement('span');
        type.className = 'ty';
        type.textContent = ev.type + ' ';
        var text = document.createElement('span');
        text.textContent = summarise(ev);
        body.appendChild(type);
        body.appendChild(text);
        row.appendChild(seq);
        row.appendChild(time);
        row.appendChild(body);
        list.appendChild(row);
      });
      if (shown === 0) {
        var empty = document.createElement('div');
        empty.className = 'evrow';
        empty.textContent = 'no events';
        list.appendChild(empty);
      }
    }
    filter.addEventListener('change', draw);
    draw();
  });
})();
`;

export function renderReportHtml(bundle: ReportBundle): string {
  const record = bundle.record;
  const title = record.spec.title ?? record.task.title;
  const winner = record.verdict?.winner ?? null;
  const winnerText =
    winner === 'a'
      ? record.runs.a.label + ' wins'
      : winner === 'b'
        ? record.runs.b.label + ' wins'
        : winner === 'tie'
          ? 'Tie'
          : winner === 'inconclusive'
            ? 'Inconclusive'
            : 'No verdict';
  const winnerClass = winner === 'a' ? 'side-a' : winner === 'b' ? 'side-b' : '';

  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<title>' + escapeHtml('Harness Arena — ' + title) + '</title>',
    '<style>' + CSS + '</style>',
    '</head><body><main>',

    '<header>',
    '<div class="head-row">',
    '<h1>' + escapeHtml(title) + '</h1>',
    record.demo ? '<span class="pill demo">demo data</span>' : '',
    '<span class="pill">' + escapeHtml(record.status) + '</span>',
    '<span class="pill">' + escapeHtml(record.spec.mode) + '</span>',
    '</div>',
    '<p class="winner ' + winnerClass + '">' + escapeHtml(winnerText) + '</p>',
    '<p class="muted">' +
      escapeHtml(
        record.runs.a.label +
          ' (' +
          record.runs.a.agent.id +
          ' / ' +
          record.runs.a.harness.name +
          ')  vs  ' +
          record.runs.b.label +
          ' (' +
          record.runs.b.agent.id +
          ' / ' +
          record.runs.b.harness.name +
          ')',
      ) +
      '</p>',
    '</header>',

    '<section><h2>Task</h2><pre>' + escapeHtml(record.task.prompt) + '</pre></section>',

    '<section><h2>Verdict</h2>' + verdictSection(record) + '</section>',

    '<section><h2>Insights</h2>' + insightsSection(record.insights) + '</section>',

    '<section><h2>Metrics</h2>',
    '<table><thead><tr><th scope="col">Metric</th>',
    '<th scope="col" class="side-a">' + escapeHtml(record.runs.a.label) + '</th>',
    '<th scope="col" class="side-b">' + escapeHtml(record.runs.b.label) + '</th>',
    '</tr></thead><tbody>',
    metricRows(record),
    '</tbody></table>',
    '<p class="muted">observed = the CLI reported it · calculated = Arena derived it · estimated = heuristic · n/a = the CLI cannot report it (never shown as zero).</p>',
    '</section>',

    '<section><h2>Timeline</h2>',
    '<div class="timeline">',
    '<div class="lane a"></div>',
    '<div class="lane b"></div>',
    '<input id="scrub" type="range" min="0" max="1" step="1" value="1" aria-label="Scrub the battle timeline">',
    '<p class="muted" id="scrub-clock"></p>',
    '<div class="cursor-row">',
    '<div><h4 class="side-a">' +
      escapeHtml(record.runs.a.label) +
      '</h4><div id="cursor-a" class="muted"></div></div>',
    '<div><h4 class="side-b">' +
      escapeHtml(record.runs.b.label) +
      '</h4><div id="cursor-b" class="muted"></div></div>',
    '</div></div></section>',

    '<section><h2>Event log</h2><div class="grid2">',
    SIDES.map(
      (side) =>
        '<div><h4 id="log-head-' +
        side +
        '"></h4><div class="controls"><label>Filter <select id="filter-' +
        side +
        '"><option value="*">all types</option></select></label></div><div class="evlog" id="log-' +
        side +
        '"></div></div>',
    ).join(''),
    '</div></section>',

    '<section><h2>Tests</h2>' + testsSection(record) + '</section>',

    '<section><h2>Changes</h2>',
    SIDES.map(
      (side) =>
        '<h3 class="side-' +
        side +
        '">' +
        escapeHtml(record.runs[side].label) +
        '</h3>' +
        diffSection(record.runs[side]),
    ).join(''),
    '</section>',

    '<section><h2>Errors</h2>' + errorsSection(record) + '</section>',

    '<section><h2>What was executed</h2>' + invocationSection(record) + '</section>',

    '<section><h2>Environment and reproducibility</h2>' + environmentSection(record, bundle) + '</section>',

    '<footer>Harness Arena ' +
      escapeHtml(bundle.arenaVersion) +
      ' · battle ' +
      escapeHtml(record.id) +
      ' · generated ' +
      escapeHtml(bundle.generatedAt) +
      ' · no network requests, no telemetry in this file</footer>',

    '</main>',
    '<script id="arena-bundle" type="application/json">' + embedJson(bundle) + '</script>',
    '<script>' + SCRIPT + '</script>',
    '</body></html>',
  ];
  return html.filter((part) => part.length > 0).join('\n');
}
