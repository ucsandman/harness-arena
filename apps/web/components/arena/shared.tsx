import Link from 'next/link';
import {
  ARENA_EXECUTION_NOTE,
  RATING_CATEGORY_LABELS,
  type BountyStatus,
  type ChallengeStatus,
  type CompetitorRef,
  type EvidenceStrength,
  type ExperimentStatus,
  type RateSummary,
  type RatingCategory,
  type StatsSummary,
  type TournamentStatus,
  type WorkTarget,
} from '@harness-arena/protocol';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { shortCommit } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * The pieces every competitive page repeats: the "Arena hosts no runner" note, a work target, a
 * competitor, a status badge, and the small number formatters that keep a sample size next to every
 * figure. One file so six page families cannot drift apart.
 */

/** The honesty rule, rendered. Every challenge, tournament, bounty and experiment page carries it. */
export function ExecutionNote({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        'rounded-card border border-border bg-surface px-4 py-3 text-[0.8125rem] leading-relaxed text-fg-muted',
        className,
      )}
    >
      {ARENA_EXECUTION_NOTE}
    </p>
  );
}

export const CHALLENGE_STATUS_VARIANT: Record<ChallengeStatus, BadgeVariant> = {
  open: 'accent',
  accepted: 'warn',
  completed: 'success',
  cancelled: 'neutral',
  expired: 'neutral',
};

export const TOURNAMENT_STATUS_VARIANT: Record<TournamentStatus, BadgeVariant> = {
  draft: 'neutral',
  open: 'accent',
  running: 'accent',
  completed: 'success',
  cancelled: 'neutral',
};

export const BOUNTY_STATUS_VARIANT: Record<BountyStatus, BadgeVariant> = {
  open: 'accent',
  closed: 'neutral',
  awarded: 'success',
  expired: 'neutral',
  cancelled: 'neutral',
};

export const EXPERIMENT_STATUS_VARIANT: Record<ExperimentStatus, BadgeVariant> = {
  planned: 'neutral',
  running: 'accent',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const EVIDENCE_VARIANT: Record<EvidenceStrength['level'], BadgeVariant> = {
  none: 'unavailable',
  low: 'warn',
  medium: 'accent',
  high: 'success',
};

/** An evidence level never appears without the sample it was derived from. */
export function EvidenceBadge({ evidence }: { evidence: EvidenceStrength }) {
  return (
    <Badge variant={EVIDENCE_VARIANT[evidence.level]} title={evidence.rationale}>
      evidence: {evidence.level} (n={evidence.n})
    </Badge>
  );
}

export function categoryLabel(category: string): string {
  return RATING_CATEGORY_LABELS[category as RatingCategory] ?? category;
}

/** A harness as a competitor: the label a human reads, then the source and commit a machine resolves. */
export function CompetitorLine({
  competitor,
  side,
}: {
  competitor: CompetitorRef;
  side?: 'a' | 'b' | 'control' | 'treatment';
}) {
  const label =
    competitor.label ?? (competitor.harness.source === 'vanilla' ? 'vanilla' : competitor.harness.source);
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {side ? (
        <Badge variant={side === 'a' || side === 'control' ? 'side-a' : 'side-b'} mono>
          {side}
        </Badge>
      ) : null}
      <span className="truncate text-[0.8125rem] font-medium">{label}</span>
      <span className="truncate font-mono text-2xs text-fg-subtle">
        {competitor.harness.source}
        {competitor.harness.commit ? '@' + shortCommit(competitor.harness.commit) : ''}
      </span>
    </span>
  );
}

/** What is being run: a published pack version (optionally one task of it) or an inline task. */
export function TargetSummary({ target, className }: { target: WorkTarget; className?: string }) {
  if (target.kind === 'benchmark') {
    const query = new URLSearchParams({ version: target.versionId });
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">benchmark pack</Badge>
          <Link
            href={`/benchmarks/${target.slug}?${query.toString()}`}
            className="text-[0.8125rem] font-medium hover:text-accent"
          >
            {target.slug}
          </Link>
          {target.taskId ? (
            <span className="font-mono text-2xs text-fg-muted">task {target.taskId}</span>
          ) : null}
        </span>
        <span className="font-mono text-2xs text-fg-subtle">{target.versionId}</span>
      </div>
    );
  }

  const title =
    target.title ??
    (target.task.kind === 'prompt'
      ? target.task.prompt.split('\n')[0]?.slice(0, 120)
      : `${target.task.repo}#${target.task.number}`);
  const pinned = target.repository.commit
    ? '@' + shortCommit(target.repository.commit)
    : target.repository.ref
      ? '@' + target.repository.ref
      : '';
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">inline task</Badge>
        <span className="text-[0.8125rem] font-medium">{title}</span>
        <Badge variant="neutral">{categoryLabel(target.category)}</Badge>
      </span>
      <span className="font-mono text-2xs text-fg-subtle">
        {target.repository.source}
        {pinned}
        {target.evaluation.tests ? ' · tests: ' + target.evaluation.tests.command : ''}
      </span>
    </div>
  );
}

/** A proportion with its Wilson interval and its denominator. A null rate renders n/a, never 0%. */
export function RateCell({ rate }: { rate: RateSummary }) {
  if (rate.rate === null) {
    return <span className="font-mono text-2xs text-fg-subtle">n/a (n={rate.n})</span>;
  }
  return (
    <span className="font-mono text-xs tabular-nums">
      {(rate.rate * 100).toFixed(0)}%
      <span className="text-fg-subtle">
        {' '}
        {rate.successes}/{rate.n}
        {rate.ci95 ? ` [${(rate.ci95[0] * 100).toFixed(0)}-${(rate.ci95[1] * 100).toFixed(0)}]` : ''}
      </span>
    </span>
  );
}

/** mean / median / n for one metric on one side. */
export function StatsCell({
  stats,
  format,
}: {
  stats: StatsSummary;
  format: (value: number | null | undefined) => string;
}) {
  return (
    <span className="font-mono text-xs tabular-nums">
      {format(stats.mean)}
      <span className="text-fg-subtle"> med {format(stats.median)} · n={stats.n}</span>
    </span>
  );
}

/** Percentage points, signed. `null` is "not measured", never "0". */
export function deltaPointsText(points: number | null): string {
  if (points === null) return 'not measured';
  return `${points > 0 ? '+' : ''}${points.toFixed(1)} pts`;
}

export function deltaPercentText(fraction: number | null): string {
  if (fraction === null) return 'not measured';
  const percent = fraction * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

/**
 * Colour for a delta. `goodWhenNegative` is true for tokens, cost and duration, where less is better,
 * and false for correctness. A null delta is never coloured: nothing was measured.
 */
export function DeltaText({
  value,
  kind,
  goodWhenNegative = false,
}: {
  value: number | null;
  kind: 'points' | 'percent';
  goodWhenNegative?: boolean;
}) {
  const text = kind === 'points' ? deltaPointsText(value) : deltaPercentText(value);
  if (value === null || value === 0) return <span className="font-mono text-xs text-fg-muted">{text}</span>;
  const good = goodWhenNegative ? value < 0 : value > 0;
  return (
    <span className={cn('font-mono text-xs font-medium tabular-nums', good ? 'text-success' : 'text-danger')}>
      {text}
    </span>
  );
}

/** The honest empty state used by every list and section on these pages. */
export function EmptyPanel({
  title,
  note,
  className,
  children,
}: {
  title: string;
  note: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-card border border-border bg-surface px-4 py-5', className)}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-2xl text-[0.8125rem] text-fg-muted">{note}</p>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

/** Link list of battles, used wherever a definition points at the community battles behind it. */
export function BattleLinks({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return <span className="font-mono text-2xs text-fg-subtle">none yet</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {ids.map((id) => (
        <Link key={id} href={`/battles/${id}`} className="font-mono text-2xs text-accent hover:underline">
          {id}
        </Link>
      ))}
    </span>
  );
}
