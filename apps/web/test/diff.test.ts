import { describe, expect, it } from 'vitest';
import { diffFileLabel, diffStatusLabel, parseUnifiedDiff } from '../lib/diff';

const MULTI_FILE = [
  'diff --git a/src/one.ts b/src/one.ts',
  'index 3f8a1c2..b21d904 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export { a, b };',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const added = true;',
  '+',
  '\\ No newline at end of file',
  '',
].join('\n');

const RENAME = [
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 96%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  '--- a/old/name.ts',
  '+++ b/new/name.ts',
  '@@ -3,3 +3,3 @@',
  ' keep',
  '-was',
  '+is',
  '',
].join('\n');

const BINARY = [
  'diff --git a/logo.png b/logo.png',
  'index 1234567..89abcde 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

const DELETION = [
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parses a multi-file diff with line numbers', () => {
    const parsed = parseUnifiedDiff(MULTI_FILE);
    expect(parsed.files).toHaveLength(2);

    const [first, second] = parsed.files;
    expect(first?.path).toBe('src/one.ts');
    expect(first?.status).toBe('modified');
    expect(first?.additions).toBe(2);
    expect(first?.deletions).toBe(1);
    expect(first?.hunks).toHaveLength(1);

    const lines = first?.hunks[0]?.lines ?? [];
    expect(lines.map((line) => line.type)).toEqual(['context', 'removed', 'added', 'added', 'context']);
    expect(lines[0]).toMatchObject({ oldNumber: 1, newNumber: 1, content: 'const a = 1;' });
    expect(lines[1]).toMatchObject({ oldNumber: 2, newNumber: null });
    expect(lines[2]).toMatchObject({ oldNumber: null, newNumber: 2 });
    expect(lines[4]).toMatchObject({ oldNumber: 3, newNumber: 4 });

    expect(second?.status).toBe('added');
    expect(second?.path).toBe('src/new.ts');
    expect(parsed.additions).toBe(4);
    expect(parsed.deletions).toBe(1);
    expect(parsed.truncated).toBe(false);
  });

  it('parses renames and keeps both paths', () => {
    const parsed = parseUnifiedDiff(RENAME);
    const file = parsed.files[0];
    expect(file?.status).toBe('renamed');
    expect(file?.path).toBe('new/name.ts');
    expect(file?.oldPath).toBe('old/name.ts');
    expect(file && diffFileLabel(file)).toBe('old/name.ts -> new/name.ts');
    expect(file?.additions).toBe(1);
  });

  it('flags binary files instead of trying to render them', () => {
    const parsed = parseUnifiedDiff(BINARY);
    const file = parsed.files[0];
    expect(file?.binary).toBe(true);
    expect(file?.hunks).toHaveLength(0);
    expect(file?.note).toBe('Binary file not shown');
  });

  it('parses deletions', () => {
    const parsed = parseUnifiedDiff(DELETION);
    const file = parsed.files[0];
    expect(file?.status).toBe('deleted');
    expect(file?.path).toBe('gone.ts');
    expect(file?.deletions).toBe(2);
    expect(diffStatusLabel('deleted')).toBe('deleted');
  });

  it('handles CRLF input and empty input without throwing', () => {
    const parsed = parseUnifiedDiff(MULTI_FILE.replace(/\n/g, '\r\n'));
    expect(parsed.files).toHaveLength(2);
    expect(parseUnifiedDiff('').files).toEqual([]);
    expect(parseUnifiedDiff('   ').files).toEqual([]);
    expect(parseUnifiedDiff('not a diff at all').files).toEqual([]);
  });

  it('reports truncation when the input exceeds the line budget', () => {
    const parsed = parseUnifiedDiff(MULTI_FILE, { maxLines: 6 });
    expect(parsed.truncated).toBe(true);
    expect(parsed.files.length).toBeGreaterThan(0);
  });
});
