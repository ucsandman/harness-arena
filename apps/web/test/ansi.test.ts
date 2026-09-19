import { describe, expect, it } from 'vitest';
import { cleanOutput, clampText, hasAnsi, stripAnsi } from '../lib/ansi';

describe('stripAnsi', () => {
  it('removes colour and cursor sequences', () => {
    expect(stripAnsi('\u001B[31mFAIL\u001B[0m test/retry.test.ts')).toBe('FAIL test/retry.test.ts');
    expect(stripAnsi('\u001B[2K\u001B[1Gprogress')).toBe('progress');
    expect(stripAnsi('\u001B[38;5;208mwarn\u001B[39m')).toBe('warn');
  });

  it('removes OSC sequences including titles and hyperlinks', () => {
    expect(stripAnsi('\u001B]0;window title\u0007done')).toBe('done');
    expect(stripAnsi('\u001B]8;;https://example.com\u001B\\link\u001B]8;;\u001B\\')).toBe('link');
  });

  it('keeps newlines and tabs but drops other control characters', () => {
    expect(stripAnsi('a\nb\tc\u0000d')).toBe('a\nb\tcd');
  });

  it('is a no-op for clean text', () => {
    expect(stripAnsi('plain')).toBe('plain');
    expect(hasAnsi('plain')).toBe(false);
    expect(hasAnsi('\u001B[31mred')).toBe(true);
    expect(stripAnsi('')).toBe('');
  });
});

describe('cleanOutput', () => {
  it('normalises CRLF and keeps only the final carriage-return frame', () => {
    expect(cleanOutput('one\r\ntwo')).toBe('one\ntwo');
    expect(cleanOutput('25%\r50%\r100%\ndone')).toBe('100%\ndone');
  });
});

describe('clampText', () => {
  it('leaves short text alone', () => {
    expect(clampText('short', 20)).toEqual({ text: 'short', truncated: false });
  });

  it('cuts on a word boundary when one is close enough', () => {
    const { text, truncated } = clampText('the quick brown fox jumps over', 20);
    expect(truncated).toBe(true);
    expect(text).toBe('the quick brown fox');
  });

  it('hard-cuts when there is no nearby boundary', () => {
    const { text, truncated } = clampText('a'.repeat(50), 10);
    expect(truncated).toBe(true);
    expect(text).toHaveLength(10);
  });
});
