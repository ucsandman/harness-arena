import type { RatingHistoryPoint } from '@harness-arena/protocol';

/**
 * The rating curve, drawn as a plain inline SVG. No chart library on purpose: the shape is one
 * polyline over the `rating_events` audit trail, and a dependency that renders it would also have to
 * ship to the browser for a server-rendered page that never interacts.
 *
 * The band around the line is the Glicko deviation — the interval the rating is actually known to,
 * so a provisional harness reads as uncertain instead of precise. The y axis is labelled with real
 * rating values and the x axis with the first and last battle dates; nothing is interpolated beyond
 * the points themselves, and a single point renders as a dot with a note rather than a fake trend.
 */

const WIDTH = 720;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 22, left: 46 };

export function RatingChart({ points, label }: { points: RatingHistoryPoint[]; label: string }) {
  if (points.length === 0) {
    return (
      <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">
        No rating events yet, so there is no curve to draw.
      </p>
    );
  }

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const lows = points.map((p) => p.rating - p.deviation);
  const highs = points.map((p) => p.rating + p.deviation);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  // a flat series would divide by zero; give it a 20-point window so the line sits in the middle
  const span = max - min < 1 ? 20 : max - min;
  const base = max - min < 1 ? min - 10 : min;

  const x = (index: number): number =>
    PAD.left + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
  const y = (value: number): number => PAD.top + plotH - ((value - base) / span) * plotH;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`);
  const bandTop = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(highs[i] as number).toFixed(1)}`);
  const bandBottom = [...points]
    .map((p, i) => ({ i, value: lows[i] as number }))
    .reverse()
    .map((p) => `L${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`);
  const band = points.length > 1 ? [...bandTop, ...bandBottom, 'Z'].join(' ') : null;

  const ticks = [base + span, base + span / 2, base].map((value) => ({ value, y: y(value) }));
  const first = points[0] as RatingHistoryPoint;
  const last = points[points.length - 1] as RatingHistoryPoint;

  return (
    <figure className="px-4 py-3">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-48 w-full"
        role="img"
        aria-label={`${label}: ${points.length} rating events, from ${Math.round(first.rating)} to ${Math.round(last.rating)}`}
      >
        {ticks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={tick.y}
              y2={tick.y}
              stroke="currentColor"
              strokeWidth="1"
              className="text-border"
            />
            <text
              x={PAD.left - 6}
              y={tick.y + 3}
              textAnchor="end"
              className="fill-current font-mono text-[9px] text-fg-subtle"
            >
              {Math.round(tick.value)}
            </text>
          </g>
        ))}

        {band ? <path d={band} className="fill-current text-accent opacity-10" /> : null}
        {points.length > 1 ? (
          <path
            d={line.join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
            className="text-accent"
          />
        ) : null}
        {points.map((point, index) => (
          <circle
            key={`${point.battleId}-${index}`}
            cx={x(index)}
            cy={y(point.rating)}
            r={points.length > 60 ? 1.5 : 2.5}
            className="fill-current text-accent"
          >
            <title>{`${point.at.slice(0, 10)} · ${Math.round(point.rating)} ±${Math.round(point.deviation)} · ${point.outcome} vs ${point.opponentSlug ?? 'unknown'}`}</title>
          </circle>
        ))}

        <text
          x={PAD.left}
          y={HEIGHT - 6}
          className="fill-current font-mono text-[9px] text-fg-subtle"
        >
          {first.at.slice(0, 10)}
        </text>
        <text
          x={WIDTH - PAD.right}
          y={HEIGHT - 6}
          textAnchor="end"
          className="fill-current font-mono text-[9px] text-fg-subtle"
        >
          {last.at.slice(0, 10)}
        </text>
      </svg>
      <figcaption className="mt-1 text-2xs text-fg-subtle">
        {points.length === 1
          ? 'One rating event. A single point is a starting position, not a trend.'
          : `${points.length} rating events. The shaded band is the Glicko deviation at each point: how uncertain that rating was.`}
      </figcaption>
    </figure>
  );
}
