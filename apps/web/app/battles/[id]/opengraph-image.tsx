import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import type { BattleRecord, RunRecord } from '@harness-arena/protocol';
import { getBattleForViewer } from '@harness-arena/database';
import { BRAND } from '@/lib/brand';
import { db } from '@/lib/db';
import { formatDurationShort, formatTokens, formatUsd } from '@/lib/format';

export const alt = `${BRAND.name}: battle report`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// This card is rendered from the database per request. Next caches an opengraph-image route
// by default, which would freeze one battle's numbers into every later share.
export const dynamic = 'force-dynamic';

/**
 * Static hex colours here on purpose: the OG renderer has no CSS variables and no oklch support, so
 * these mirror the dark theme tokens in app/globals.css (same palette as app/opengraph-image.tsx).
 */
const COLOR = {
  bg: '#14171f',
  panel: '#1b1f29',
  border: '#2c313d',
  fg: '#f2f4f8',
  muted: '#9aa3b2',
  sideA: '#5b8df6',
  sideB: '#f0a02c',
  success: '#3fb950',
  warn: '#d9a343',
};

/** The generic site card, identical to app/opengraph-image.tsx: used whenever a battle cannot be shown. */
function genericCard(): ReactElement {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: COLOR.bg,
        padding: '72px',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
        <svg width="46" height="46" viewBox="0 0 24 24" fill="none" strokeWidth="2.25" strokeLinecap="round">
          <path d="M4 6l5 6-5 6" stroke={COLOR.sideA} />
          <path d="M20 6l-5 6 5 6" stroke={COLOR.sideB} />
          <path d="M12 3.5v17" stroke={COLOR.border} strokeWidth="1.5" />
        </svg>
        <div style={{ color: COLOR.fg, fontSize: 34, fontWeight: 600 }}>{BRAND.name}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
        <div
          style={{
            color: COLOR.fg,
            fontSize: 76,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
          }}
        >
          {BRAND.tagline}
        </div>
        <div style={{ color: COLOR.muted, fontSize: 30, lineHeight: 1.35, maxWidth: 900 }}>
          Battle coding agent setups on the same task and see what actually performs better.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        {[
          { label: 'Side A', color: COLOR.sideA },
          { label: 'Side B', color: COLOR.sideB },
        ].map((side) => (
          <div
            key={side.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              backgroundColor: COLOR.panel,
              border: `1px solid ${COLOR.border}`,
              borderRadius: 999,
              padding: '10px 22px',
              color: side.color,
              fontSize: 24,
            }}
          >
            <div style={{ width: 12, height: 12, borderRadius: 999, backgroundColor: side.color }} />
            {side.label}
          </div>
        ))}
        <div style={{ color: COLOR.muted, fontSize: 24, marginLeft: 'auto', fontFamily: 'monospace' }}>
          {BRAND.cli.npx}
        </div>
      </div>
    </div>
  );
}

function pill(label: string, color: string): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        backgroundColor: COLOR.panel,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: '6px 16px',
        color,
        fontSize: 18,
        fontWeight: 600,
      }}
    >
      {label}
    </div>
  );
}

function winnerLine(record: BattleRecord, labelA: string, labelB: string): string {
  const winner = record.verdict?.winner;
  const base =
    winner === 'a'
      ? `${labelA} wins`
      : winner === 'b'
        ? `${labelB} wins`
        : winner === 'tie'
          ? 'Tie'
          : 'Inconclusive';
  return record.demo ? `${base} — demo data` : base;
}

function metricNumber(run: RunRecord, key: 'tokens_total' | 'cost_usd' | 'duration_ms'): number | null {
  const metric = run.metrics[key];
  if (!metric || metric.status === 'unavailable' || typeof metric.value !== 'number') return null;
  return metric.value;
}

function stat(label: string, value: string): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ fontSize: 14, color: COLOR.muted }}>{label}</div>
      <div style={{ fontSize: 20, color: COLOR.fg, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function sidePanel(color: string, name: string, gatesText: string, run: RunRecord): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        gap: '12px',
        backgroundColor: COLOR.panel,
        border: `1px solid ${COLOR.border}`,
        borderRadius: 12,
        padding: '18px 22px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ width: 10, height: 10, borderRadius: 999, backgroundColor: color }} />
        <div style={{ fontSize: 20, fontWeight: 600, color }}>{name}</div>
      </div>
      <div style={{ display: 'flex', gap: '20px' }}>
        {stat('Gates', gatesText)}
        {stat('Tokens', formatTokens(metricNumber(run, 'tokens_total')))}
        {stat('Cost', formatUsd(metricNumber(run, 'cost_usd')))}
        {stat('Time', formatDurationShort(metricNumber(run, 'duration_ms')))}
      </div>
    </div>
  );
}

/** `4/5 gates`-style correctness tally per side: non-efficiency gates the side won or tied. */
function gatesText(record: BattleRecord, side: 'a' | 'b'): string {
  const gates = (record.verdict?.breakdown ?? []).filter(
    (row) => row.factor !== 'efficiency' && row.result !== 'n/a',
  );
  if (gates.length === 0) return 'n/a';
  const won = gates.filter((row) => row.result === side || row.result === 'tie').length;
  return `${won}/${gates.length} gates`;
}

function battleCard(record: BattleRecord): ReactElement {
  const a = record.runs.a;
  const b = record.runs.b;
  const nameA = a.harness.name;
  const nameB = b.harness.name;
  const subtitleParts = [
    record.spec.category ?? null,
    record.spec.benchmark ? `benchmark ${record.spec.benchmark.slug}` : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: COLOR.bg,
        padding: '56px',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            strokeWidth="2.25"
            strokeLinecap="round"
          >
            <path d="M4 6l5 6-5 6" stroke={COLOR.sideA} />
            <path d="M20 6l-5 6 5 6" stroke={COLOR.sideB} />
            <path d="M12 3.5v17" stroke={COLOR.border} strokeWidth="1.5" />
          </svg>
          <div style={{ color: COLOR.fg, fontSize: 24, fontWeight: 600 }}>{BRAND.name}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {record.demo ? pill('DEMO', COLOR.warn) : null}
          {pill(record.verification.eligible ? 'Verified' : 'Community', COLOR.success)}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {subtitleParts.length > 0 ? (
          <div style={{ fontSize: 20, color: COLOR.muted }}>{subtitleParts.join(' · ')}</div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
          <div style={{ fontSize: 48, fontWeight: 700, color: COLOR.sideA }}>{nameA}</div>
          <div style={{ fontSize: 30, color: COLOR.muted }}>vs</div>
          <div style={{ fontSize: 48, fontWeight: 700, color: COLOR.sideB }}>{nameB}</div>
        </div>
        <div style={{ fontSize: 26, color: COLOR.fg }}>{winnerLine(record, nameA, nameB)}</div>
      </div>

      <div style={{ display: 'flex', gap: '16px' }}>
        {sidePanel(COLOR.sideA, nameA, gatesText(record, 'a'), a)}
        {sidePanel(COLOR.sideB, nameB, gatesText(record, 'b'), b)}
      </div>
    </div>
  );
}

export default async function BattleOpengraphImage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ImageResponse> {
  const { id } = await params;
  const dbh = await db();
  const found = await getBattleForViewer(dbh, id, null);

  if (!found || found.battle.visibility !== 'public') {
    return new ImageResponse(genericCard(), size);
  }
  return new ImageResponse(battleCard(found.battle.record), size);
}
