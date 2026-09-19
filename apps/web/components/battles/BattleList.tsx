import Link from 'next/link';
import type { BattleListItem, BattleStatus } from '@harness-arena/protocol';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { SideChip } from '@/components/battle/shared';
import { BRAND } from '@/lib/brand';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

const STATUS_VARIANT: Record<BattleStatus, BadgeVariant> = {
  pending: 'neutral',
  preparing: 'neutral',
  running: 'accent',
  evaluating: 'accent',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export function BattleStatusBadge({ status }: { status: BattleStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}

export function WinnerBadge({ winner }: { winner: BattleListItem['winner'] }) {
  if (!winner) return null;
  if (winner === 'tie') return <Badge variant="neutral">Tie</Badge>;
  if (winner === 'inconclusive') return <Badge variant="warn">Inconclusive</Badge>;
  return <Badge variant={winner === 'a' ? 'side-a' : 'side-b'}>{winner.toUpperCase()} wins</Badge>;
}

function Competitor({ side, entry }: { side: 'a' | 'b'; entry: BattleListItem['a'] }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <SideChip side={side} label={entry.label} />
      <span className="truncate font-mono text-2xs text-fg-subtle">
        {entry.harness} / {entry.agent}
      </span>
    </span>
  );
}

export function BattleRow({ battle }: { battle: BattleListItem }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 hover:bg-bg-subtle">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/battles/${battle.id}`} className="min-w-0 text-sm font-medium hover:text-accent">
          {battle.title}
        </Link>
        <WinnerBadge winner={battle.winner} />
        <BattleStatusBadge status={battle.status} />
        {battle.demo ? <Badge variant="demo">Demo data</Badge> : null}
        {battle.visibility !== 'public' ? <Badge variant="outline">{battle.visibility}</Badge> : null}
        <span className="ml-auto whitespace-nowrap text-2xs text-fg-subtle">
          {relativeTime(battle.completedAt ?? battle.createdAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Competitor side="a" entry={battle.a} />
        <span className="text-2xs text-fg-subtle" aria-hidden="true">
          vs
        </span>
        <Competitor side="b" entry={battle.b} />
      </div>
    </li>
  );
}

/** The honest empty state: there is nothing to show until someone runs a battle on their machine. */
export function EmptyBattles({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-5">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 max-w-2xl text-[0.8125rem] text-fg-muted">{note}</p>
      </div>
      <CodeBlock
        terminal
        code={[
          `${BRAND.cli.install}`,
          `${BRAND.cli.bin} login`,
          `${BRAND.cli.bin} battle --task "Fix the failing test" --a vanilla --b ./my-harness`,
        ].join('\n')}
      />
      <div className="flex flex-wrap gap-2">
        <Button href="/docs/cli" size="sm">
          CLI guide
        </Button>
        <Button href="/battles/new" size="sm" variant="secondary">
          Build a battle spec
        </Button>
      </div>
    </div>
  );
}

export function BattleList({
  battles,
  className,
  empty,
}: {
  battles: BattleListItem[];
  className?: string;
  empty?: React.ReactNode;
}) {
  if (battles.length === 0) return <>{empty ?? null}</>;
  return (
    <ul className={cn('divide-y divide-border rounded-card border border-border bg-surface', className)}>
      {battles.map((battle) => (
        <BattleRow key={battle.id} battle={battle} />
      ))}
    </ul>
  );
}
