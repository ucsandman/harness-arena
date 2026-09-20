import { createHash } from 'node:crypto';

/**
 * A shields.io-style flat SVG badge, rendered by hand: no react, no image library, no dependency. The
 * text width is an approximation (fixed width per character) rather than a real font measurement,
 * which is what every dependency-free badge generator does server-side; it is close enough that the
 * two rectangles always contain their text, never exact typography.
 */

export const BADGE_COLORS = {
  label: '#3a3f4b',
  value: '#e5b53f',
  text: '#ffffff',
  valueText: '#1a1d24',
} as const;

const CHAR_WIDTH_PX = 6.2;
const TEXT_PADDING_PX = 10;
const BADGE_HEIGHT = 20;

/** Escapes the five XML-significant characters; `&` first so its own escape is never re-escaped. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Approximate rendered width at font-size 11: a fixed per-character width plus side padding. */
export function badgeTextWidth(text: string): number {
  return Math.round(text.length * CHAR_WIDTH_PX + TEXT_PADDING_PX);
}

export function renderBadge({ label, value }: { label: string; value: string }): string {
  const labelWidth = badgeTextWidth(label);
  const valueWidth = badgeTextWidth(value);
  const width = labelWidth + valueWidth;
  const escapedLabel = escapeXml(label);
  const escapedValue = escapeXml(value);
  const labelX = labelWidth / 2;
  const valueX = labelWidth + valueWidth / 2;
  const textY = BADGE_HEIGHT / 2 + 3.5;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BADGE_HEIGHT}" role="img" ` +
    `aria-label="${escapedLabel}: ${escapedValue}">` +
    `<title>${escapedLabel}: ${escapedValue}</title>` +
    `<rect width="${labelWidth}" height="${BADGE_HEIGHT}" fill="${BADGE_COLORS.label}"/>` +
    `<rect x="${labelWidth}" width="${valueWidth}" height="${BADGE_HEIGHT}" fill="${BADGE_COLORS.value}"/>` +
    `<text x="${labelX}" y="${textY}" fill="${BADGE_COLORS.text}" ` +
    `font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11" text-anchor="middle">${escapedLabel}</text>` +
    `<text x="${valueX}" y="${textY}" fill="${BADGE_COLORS.valueText}" ` +
    `font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11" text-anchor="middle">${escapedValue}</text>` +
    `</svg>`
  );
}

/** A deterministic weak etag: the value never changes without the etag changing with it. */
export function badgeEtag(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `W/"${hash}"`;
}
