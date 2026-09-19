/**
 * A tolerant unified-diff parser. Input is text produced by `git diff` on the machine that ran the
 * battle; it is never executed, never interpreted as HTML, and never trusted to be well formed.
 */

export type DiffLineType = 'context' | 'added' | 'removed';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  /** new path (or the old path for a deletion) */
  path: string;
  /** previous path for renames, null otherwise */
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** e.g. "Binary file not shown" */
  note: string | null;
}

export interface ParsedDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** true when the input exceeded maxLines and parsing stopped early */
  truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function newFile(path: string): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    note: null,
  };
}

/** Strip the a/ or b/ prefix git adds, and the quoting it applies to unusual names. */
function cleanPath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
  if (value === '/dev/null') return value;
  if (/^[ab]\//.test(value)) value = value.slice(2);
  return value;
}

export function parseUnifiedDiff(input: string, options: { maxLines?: number } = {}): ParsedDiff {
  const maxLines = options.maxLines ?? 60_000;
  const files: DiffFile[] = [];
  if (!input || !input.trim()) return { files, additions: 0, deletions: 0, truncated: false };

  const allLines = input.replace(/\r\n/g, '\n').split('\n');
  const truncated = allLines.length > maxLines;
  const lines = truncated ? allLines.slice(0, maxLines) : allLines;

  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  const push = () => {
    if (current) files.push(current);
    current = null;
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      push();
      const match = /^diff --git (.+) (.+)$/.exec(line);
      const to = match ? cleanPath(match[2] as string) : '';
      const from = match ? cleanPath(match[1] as string) : '';
      current = newFile(to || from || 'unknown');
      continue;
    }

    if (line.startsWith('--- ')) {
      const from = cleanPath(line.slice(4));
      if (!current) current = newFile(from === '/dev/null' ? 'unknown' : from);
      if (from === '/dev/null') current.status = 'added';
      else if (current.oldPath === null) current.oldPath = from;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const to = cleanPath(line.slice(4));
      if (!current) current = newFile(to);
      if (to === '/dev/null') current.status = 'deleted';
      else if (!current.path || current.path === 'unknown') current.path = to;
      continue;
    }

    if (!current) {
      // Content before any file header (e.g. a commit message); ignore it.
      continue;
    }

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = cleanPath(line.slice('rename from '.length));
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = cleanPath(line.slice('rename to '.length));
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('copy from ') || line.startsWith('copy to ')) continue;
    if (line.startsWith('similarity index') || line.startsWith('dissimilarity index')) continue;
    if (line.startsWith('index ') || line.startsWith('old mode') || line.startsWith('new mode')) continue;

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      current.note = 'Binary file not shown';
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      oldNumber = Number(hunkMatch[1]);
      newNumber = Number(hunkMatch[3]);
      hunk = {
        header: (hunkMatch[5] ?? '').trim(),
        oldStart: oldNumber,
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: newNumber,
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    const marker = line.charAt(0);
    const content = line.slice(1);
    if (marker === '+') {
      hunk.lines.push({ type: 'added', content, oldNumber: null, newNumber });
      newNumber += 1;
      current.additions += 1;
    } else if (marker === '-') {
      hunk.lines.push({ type: 'removed', content, oldNumber, newNumber: null });
      oldNumber += 1;
      current.deletions += 1;
    } else if (marker === ' ' || line === '') {
      hunk.lines.push({ type: 'context', content, oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  push();

  return {
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    truncated,
  };
}

export function diffFileLabel(file: DiffFile): string {
  if (file.status === 'renamed' && file.oldPath && file.oldPath !== file.path) {
    return `${file.oldPath} -> ${file.path}`;
  }
  return file.path;
}

export function diffStatusLabel(status: DiffFileStatus): string {
  switch (status) {
    case 'added':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}
