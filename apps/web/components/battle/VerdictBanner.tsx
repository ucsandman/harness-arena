import type { BattleRecord, EfficiencyMetricKey, Verdict, VerdictBreakdownRow } from '@harness-arena/protocol';
import { CircleSlash, Equal, Info, TriangleAlert, Trophy } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { cn } from '@/lib/cn';
import { formatDurationShort, formatNumber, formatPercent, formatTokens, formatUsd } from '@/lib/format';
import { SIDE_BG, SIDE_BORDER, SIDE_TEXT, SideChip } from './shared';

const METHOD_LABEL: Record<Verdict['method'], string> = {
  deterministic: 'Deterministic evidence only',
  'deterministic+judge': 'Deterministic evidence plus a labeled LLM opinion',
  insufficient: 'Insufficient evidence',
};

/** The verdict hierarchy's stage order: correctness gates first, efficiency only breaks a clean tie. */
const FACTOR_ORDER: VerdictBreakdownRow['factor'][] = [
  'completion',
  'tests',
  'regressions',
  'assertions',
  'build',
  'efficiency',
];

const STAGE_LABEL: Record<VerdictBreakdownRow['factor'], string> = {
  completion: 'Completion',
  tests: 'Tests',
  regressions: 'Regressions',
  assertions: 'Assertions',
  build: 'Build',
  efficiency: 'Efficiency',
};

const EFFICIENCY_METRIC_LABEL: Record<EfficiencyMetricKey, string> = {
  tokens_total: 'Tokens',
  cost_usd: 'Cost',
  duration_ms: 'Duration',
};

function formatEfficiencyValue(key: EfficiencyMetricKey, value: number): string {
  switch (key) {
    case 'tokens_total':
      return formatTokens(value);
    case 'cost_usd':
      return formatUsd(value);
    case 'duration_ms':
      return formatDurationShort(value);
    default:
      return formatNumber(value);
  }
}

function formatAdvantage(advantage: number): string {
  if (advantage === 0) return 'even';
  const side = advantage > 0 ? 'A' : 'B';
  return `${formatPercent(Math.abs(advantage))} favoring side ${side}`;
}

function stageResultLabel(result: VerdictBreakdownRow['result']): string {
  if (result === 'a' || result === 'b') return `Side ${result.toUpperCase()}`;
  if (result === 'tie') return 'Tie';
  return 'n/a';
}

function headline(record: BattleRecord, verdict: Verdict): { title: string; sub: string } {
  const labelA = record.runs.a.label;
  const labelB = record.runs.b.label;
  switch (verdict.winner) {
    case 'a':
      return {
        title: `${labelA} wins`,
        sub: `Side A beat side B (${labelB}) on decisive, reproducible signals.`,
      };
    case 'b':
      return {
        title: `${labelB} wins`,
        sub: `Side B beat side A (${labelA}) on decisive, reproducible signals.`,
      };
    case 'tie':
      return { title: 'Tie', sub: 'Equally correct, and not far enough apart on efficiency to call.' };
    default:
      return {
        title: 'Inconclusive',
        sub: 'The evidence collected does not support calling a winner. The numbers are still below.',
      };
  }
}

export function VerdictBanner({ record, className }: { record: BattleRecord; className?: string }) {
  const verdict = record.verdict;

  if (!verdict) {
    return (
      <section
        aria-labelledby="verdict-heading"
        className={cn('rounded-card border border-border bg-surface p-4', className)}
      >
        <h2 id="verdict-heading" className="flex items-center gap-2 text-base font-semibold">
          <Info size={16} className="text-fg-muted" aria-hidden="true" />
          No verdict yet
        </h2>
        <p className="mt-1 text-xs text-fg-muted">
          This battle has not been evaluated. Metrics below are raw telemetry, not a comparison.
        </p>
      </section>
    );
  }

  const { title, sub } = headline(record, verdict);
  const winnerSide = verdict.winner === 'a' || verdict.winner === 'b' ? verdict.winner : null;
  const Icon = winnerSide ? Trophy : verdict.winner === 'tie' ? Equal : CircleSlash;

  return (
    <section
      aria-labelledby="verdict-heading"
      className={cn(
        'rounded-card border p-4',
        winnerSide ? cn(SIDE_BORDER[winnerSide], SIDE_BG[winnerSide]) : 'border-border bg-surface',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Icon
              size={18}
              className={winnerSide ? SIDE_TEXT[winnerSide] : 'text-fg-muted'}
              aria-hidden="true"
            />
            <h2 id="verdict-heading" className="text-base font-semibold sm:text-lg">
              {title}
            </h2>
            {winnerSide ? <SideChip side={winnerSide} /> : null}
            {record.demo ? <Badge variant="demo">Demo data</Badge> : null}
          </div>
          <p className="mt-1 max-w-2xl text-xs text-fg-muted">{sub}</p>
        </div>

        <div className="w-full max-w-64 shrink-0">
          <div className="flex items-baseline justify-between text-2xs text-fg-muted">
            <span>Confidence</span>
            <span className="font-mono tabular-nums text-fg">{formatPercent(verdict.confidence)}</span>
          </div>
          <div
            role="meter"
            aria-valuenow={Math.round(verdict.confidence * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Verdict confidence"
            className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
          >
            <div
              className={cn('h-full rounded-full', winnerSide === 'b' ? 'bg-side-b' : 'bg-side-a')}
              style={{ width: `${Math.round(verdict.confidence * 100)}%` }}
            />
          </div>
          <p className="mt-1.5 text-2xs text-fg-subtle">{METHOD_LABEL[verdict.method]}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">Why</h3>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {verdict.reasons.map((reason) => (
              <li key={reason} className="flex gap-2 text-xs leading-relaxed">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-fg-subtle" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
          {verdict.breakdown.length > 0 ? (
            <ol
              className="mt-3 grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 text-2xs"
              aria-label="Verdict breakdown"
            >
              {verdict.breakdown.map((row) => (
                <li key={row.factor} className="contents">
                  <span className="font-mono uppercase tracking-wider text-fg-subtle">{row.factor}</span>
                  <span
                    className={cn(
                      'font-mono font-semibold uppercase',
                      row.result === 'a' || row.result === 'b' ? SIDE_TEXT[row.result] : 'text-fg-muted',
                    )}
                  >
                    {row.result === 'a' || row.result === 'b' ? `side ${row.result}` : row.result}
                  </span>
                  <span className="text-fg-muted">{row.detail}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {verdict.decisiveFactors.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-2xs text-fg-subtle">Decisive:</span>
              {verdict.decisiveFactors.map((factor) => (
                <Badge key={factor} variant="accent" mono>
                  {factor}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <h3 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            <TriangleAlert size={12} aria-hidden="true" />
            What this does not prove
          </h3>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {verdict.caveats.map((caveat) => (
              <li key={caveat} className="flex gap-2 text-xs leading-relaxed text-fg-muted">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warn" />
                <span>{caveat}</span>
              </li>
            ))}
          </ul>
          {verdict.judge ? (
            <p className="mt-2 text-2xs text-fg-subtle">
              A blind LLM judge ({verdict.judge.judgeAgent}) also read both diffs and favoured{' '}
              <span className="font-mono">{verdict.judge.winner}</span>. That opinion is subjective and does
              not move the deterministic result.
            </p>
          ) : (
            <p className="mt-2 text-2xs text-fg-subtle">
              No LLM judge ran, so nothing here is a subjective score.
            </p>
          )}
        </div>
      </div>

      {verdict.breakdown.length > 0 ? (
        <div className="mt-4 border-t border-border pt-4">
          <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Why the winner won
          </h3>
          <p className="mt-1 text-xs text-fg-muted">
            The verdict hierarchy runs correctness gates first — completion, tests, regressions, assertions,
            build — and only consults efficiency once those gates end in a clean tie.
          </p>
          <TableWrap className="mt-3">
            <Table caption="Verdict stage breakdown">
              <THead>
                <TR>
                  <TH>Stage</TH>
                  <TH>Result</TH>
                  <TH>Detail</TH>
                </TR>
              </THead>
              <TBody>
                {[...verdict.breakdown]
                  .sort((a, b) => FACTOR_ORDER.indexOf(a.factor) - FACTOR_ORDER.indexOf(b.factor))
                  .map((row) => (
                    <TR key={row.factor}>
                      <TD className="font-medium">{STAGE_LABEL[row.factor]}</TD>
                      <TD
                        mono
                        className={cn(
                          'uppercase',
                          row.result === 'a' || row.result === 'b' ? SIDE_TEXT[row.result] : 'text-fg-muted',
                        )}
                      >
                        {stageResultLabel(row.result)}
                      </TD>
                      <TD className="text-fg-muted">{row.detail}</TD>
                    </TR>
                  ))}
              </TBody>
            </Table>
          </TableWrap>

          {verdict.efficiency && verdict.efficiency.metrics.length > 0 ? (
            <div className="mt-4">
              <TableWrap>
                <Table caption="Efficiency tie-break metrics">
                  <THead>
                    <TR>
                      <TH>Metric</TH>
                      <TH className="text-right">A</TH>
                      <TH className="text-right">B</TH>
                      <TH className="text-right">Weight</TH>
                      <TH className="text-right">Advantage</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {verdict.efficiency.metrics.map((metric) => (
                      <TR key={metric.key}>
                        <TD>{EFFICIENCY_METRIC_LABEL[metric.key]}</TD>
                        <TD mono className="text-right">
                          {formatEfficiencyValue(metric.key, metric.a)}
                        </TD>
                        <TD mono className="text-right">
                          {formatEfficiencyValue(metric.key, metric.b)}
                        </TD>
                        <TD mono className="text-right">
                          {metric.weight}
                        </TD>
                        <TD mono className="text-right">
                          {formatAdvantage(metric.advantage)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
              <p className="mt-2 text-2xs text-fg-subtle">
                Weighted advantage {formatPercent(Math.abs(verdict.efficiency.advantage))}
                {verdict.efficiency.advantage !== 0
                  ? ` favoring side ${verdict.efficiency.advantage > 0 ? 'A' : 'B'}`
                  : ''}{' '}
                against the {formatPercent(verdict.efficiency.minAdvantage)} needed before efficiency may name a
                winner:{' '}
                {Math.abs(verdict.efficiency.advantage) >= verdict.efficiency.minAdvantage
                  ? 'cleared it.'
                  : 'did not clear it.'}
              </p>
              {verdict.efficiency.excluded.length > 0 ? (
                <p className="mt-1 text-2xs text-fg-subtle">
                  Excluded:{' '}
                  {verdict.efficiency.excluded
                    .map((entry) => `${EFFICIENCY_METRIC_LABEL[entry.key]} (${entry.reason})`)
                    .join(', ')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
