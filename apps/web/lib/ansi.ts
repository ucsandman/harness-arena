/**
 * Agent CLIs write ANSI colour and cursor codes into their output. The report renders that text as
 * plain React children, so the escapes have to come out first (they would otherwise show as noise).
 */

/* eslint-disable no-control-regex */
const OSC = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const SINGLE = /\u001B[@-Z\\-_]/g;
const OTHER_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

/** Remove ANSI escape sequences and stray control characters, keeping newlines and tabs. */
export function stripAnsi(input: string): string {
  if (!input) return '';
  return input.replace(OSC, '').replace(CSI, '').replace(SINGLE, '').replace(OTHER_CONTROL, '');
}

export function hasAnsi(input: string): boolean {
  return stripAnsi(input) !== input;
}

/** Strip escapes, normalise CRLF, and collapse terminal carriage-return redraws to the final frame. */
export function cleanOutput(input: string): string {
  const stripped = stripAnsi(input.replace(/\r\n/g, '\n'));
  return stripped
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts[parts.length - 1] ?? '';
    })
    .join('\n');
}

/** Clamp a long string for display, on a word boundary when there is one nearby. */
export function clampText(input: string, max: number): { text: string; truncated: boolean } {
  if (input.length <= max) return { text: input, truncated: false };
  const cut = input.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return { text: (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd(), truncated: true };
}
