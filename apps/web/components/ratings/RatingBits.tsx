import Link from 'next/link';
import {
  RATING_DEFAULT,
  RATING_DEFAULT_DEVIATION,
  RATING_DEVIATION_GROWTH_C,
  RATING_FORM_WINDOW,
  RATING_MAX_RANKED_DEVIATION,
  RATING_MIN_DEVIATION,
  RATING_MIN_SAMPLE,
} from '@harness-arena/protocol';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

/**
 * The small pieces every ratings surface repeats: recent form, the provisional/ranked badge, the
 * rating ± deviation cell and the footer that states the constants behind all of it.
 *
 * They live here rather than in each page so the leaderboard and a harness profile can never disagree
 * about what "provisional" means or which constants produced a number.
 */

/**
 * Leaderboard rank: position among the RANKED rows of the whole (category, pool) table, assigned
 * before any agent filter narrows the view. A provisional row gets `null`, never a number — filtering
 * to one agent must not promote a harness to "#1" that is fourth overall, and a rating the site calls
 * provisional must not be given a rank anywhere.
 */
export function withRanks<T extends { provisional: boolean }>(rows: T[]): Array<T & { rank: number | null }> {
  let rank = 0;
  return rows.map((row) => {
    if (row.provisional) return { ...row, rank: null };
    rank += 1;
    return { ...row, rank };
  });
}

const OUTCOME_STYLE: Record<string, string> = {
  W: 'border-success-border bg-success-subtle text-success',
  L: 'border-danger-border bg-danger-subtle text-danger',
  T: 'border-border bg-neutral-subtle text-fg-muted',
};

/** Recent outcomes, oldest first, as W/L/T glyphs. An empty form renders an explicit dash. */
export function FormGlyphs({ form, className }: { form: string; className?: string }) {
  if (form.length === 0) return <span className="font-mono text-2xs text-fg-subtle">—</span>;
  return (
    <span
      className={cn('inline-flex gap-0.5', className)}
      title={`Last ${form.length} decided battles, oldest first: ${form.split('').join(' ')}`}
    >
      {form.split('').map((letter, index) => (
        <span
          key={`${letter}-${index}`}
          className={cn(
            'inline-flex h-4 w-4 items-center justify-center rounded-sm border font-mono text-[0.5625rem] font-semibold leading-none',
            OUTCOME_STYLE[letter] ?? OUTCOME_STYLE.T,
          )}
        >
          {letter}
        </span>
      ))}
    </span>
  );
}

/** Ranked or provisional, with the reason the row is not ranked in the tooltip. */
export function SampleBadge({ provisional, battles }: { provisional: boolean; battles: number }) {
  if (!provisional) return <Badge variant="success">ranked</Badge>;
  return (
    <Badge
      variant="warn"
      title={
        battles < RATING_MIN_SAMPLE
          ? `${battles} decided battles, under the minimum of ${RATING_MIN_SAMPLE}`
          : `the deviation is above ${RATING_MAX_RANKED_DEVIATION}, too wide to order`
      }
    >
      provisional
    </Badge>
  );
}

export function RatingValue({ rating, deviation }: { rating: number; deviation: number }) {
  return (
    <>
      {Math.round(rating)}
      <span className="text-fg-subtle"> ±{Math.round(deviation)}</span>
    </>
  );
}

/** The arithmetic behind every rating on the page, stated rather than implied. */
export function GlickoFootnote({ className }: { className?: string }) {
  return (
    <p className={cn('text-2xs text-fg-subtle', className)}>
      Glicko-1 on the battle verdict: start {RATING_DEFAULT} ±{RATING_DEFAULT_DEVIATION}, deviation floor{' '}
      {RATING_MIN_DEVIATION}, idle inflation c={RATING_DEVIATION_GROWTH_C} per day (
      <span className="font-mono">RD&apos; = min({RATING_DEFAULT_DEVIATION}, sqrt(RD² + c²·days))</span>),
      provisional below {RATING_MIN_SAMPLE} decided battles or above deviation{' '}
      {RATING_MAX_RANKED_DEVIATION}, form window {RATING_FORM_WINDOW}.{' '}
      <Link href="/docs/ratings" className="text-accent hover:underline">
        The full arithmetic is in the ratings doc
      </Link>
      .
    </p>
  );
}
