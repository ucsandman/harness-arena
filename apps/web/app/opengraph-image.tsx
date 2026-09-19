import { ImageResponse } from 'next/og';
import { BRAND } from '@/lib/brand';

export const alt = `${BRAND.name}: ${BRAND.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Static hex colours here on purpose: the OG renderer has no CSS variables and no oklch support, so
 * these mirror the dark theme tokens in app/globals.css.
 */
const COLOR = {
  bg: '#14171f',
  panel: '#1b1f29',
  border: '#2c313d',
  fg: '#f2f4f8',
  muted: '#9aa3b2',
  sideA: '#5b8df6',
  sideB: '#f0a02c',
};

export default function OpengraphImage() {
  return new ImageResponse(
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
    </div>,
    size,
  );
}
