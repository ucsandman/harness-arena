'use client';

import type { Side } from '@harness-arena/protocol';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { diffFileLabel, diffStatusLabel, parseUnifiedDiff, type DiffFile } from '@/lib/diff';
import { formatNumber } from '@/lib/format';
import { SIDE_DOT } from './shared';

function FileBlock({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  return (
    <details open={defaultOpen} className="group border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-xs hover:bg-bg-subtle">
        <span className="min-w-0 flex-1 truncate font-mono">{diffFileLabel(file)}</span>
        <Badge
          variant={file.status === 'added' ? 'success' : file.status === 'deleted' ? 'danger' : 'neutral'}
        >
          {diffStatusLabel(file.status)}
        </Badge>
        {file.binary ? <Badge variant="unavailable">binary</Badge> : null}
        <span className="font-mono text-2xs tabular-nums text-success">+{formatNumber(file.additions)}</span>
        <span className="font-mono text-2xs tabular-nums text-danger">-{formatNumber(file.deletions)}</span>
      </summary>

      {file.binary ? (
        <p className="px-3 pb-3 text-2xs text-fg-subtle">{file.note ?? 'Binary file not shown.'}</p>
      ) : (
        <div className="overflow-x-auto border-t border-border bg-code-bg">
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
              <div className="flex items-center gap-2 border-b border-border bg-surface-sunken px-3 py-1 font-mono text-2xs text-fg-subtle">
                <span>
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                </span>
                {hunk.header ? <span className="truncate">{hunk.header}</span> : null}
              </div>
              <table className="w-full border-collapse font-mono text-2xs leading-5">
                <tbody>
                  {hunk.lines.map((line, lineIndex) => (
                    <tr
                      key={`${hunkIndex}-${lineIndex}`}
                      className={cn(
                        line.type === 'added' && 'bg-success-subtle',
                        line.type === 'removed' && 'bg-danger-subtle',
                      )}
                    >
                      <td className="w-10 select-none border-r border-border px-2 text-right align-top text-fg-subtle tabular-nums">
                        {line.oldNumber ?? ''}
                      </td>
                      <td className="w-10 select-none border-r border-border px-2 text-right align-top text-fg-subtle tabular-nums">
                        {line.newNumber ?? ''}
                      </td>
                      <td
                        className={cn(
                          'w-4 select-none px-1 text-center align-top',
                          line.type === 'added' && 'text-success',
                          line.type === 'removed' && 'text-danger',
                          line.type === 'context' && 'text-fg-subtle',
                        )}
                      >
                        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                      </td>
                      <td className="whitespace-pre px-2 align-top text-code-fg">{line.content || ' '}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {file.hunks.length === 0 ? (
            <p className="px-3 py-2 text-2xs text-fg-subtle">No textual hunks in this file entry.</p>
          ) : null}
        </div>
      )}
    </details>
  );
}

/**
 * Renders a unified diff string. Everything is text: the diff is parsed into rows and printed as React
 * children, never injected as HTML.
 */
export function DiffViewer({
  diffA,
  diffB,
  labelA,
  labelB,
  className,
}: {
  diffA: string | null;
  diffB: string | null;
  labelA: string;
  labelB: string;
  className?: string;
}) {
  const [side, setSide] = useState<Side>('a');
  const raw = side === 'a' ? diffA : diffB;
  const parsed = useMemo(() => parseUnifiedDiff(raw ?? ''), [raw]);

  return (
    <section
      className={cn('rounded-card border border-border bg-surface', className)}
      aria-label="Workspace diff"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <div
          role="group"
          aria-label="Diff side"
          className="inline-flex overflow-hidden rounded-md border border-border"
        >
          {(['a', 'b'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSide(value)}
              aria-pressed={side === value}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium',
                side === value ? 'bg-bg-subtle text-fg' : 'text-fg-muted hover:bg-bg-subtle',
              )}
            >
              <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', SIDE_DOT[value])} />
              {value === 'a' ? `A: ${labelA}` : `B: ${labelB}`}
            </button>
          ))}
        </div>
        <span className="font-mono text-2xs tabular-nums text-fg-muted">
          {parsed.files.length} files, +{formatNumber(parsed.additions)} / -{formatNumber(parsed.deletions)}
        </span>
      </div>

      {raw === null ? (
        <p className="p-4 text-xs text-fg-muted">
          No diff was captured for this side. Diffs are excluded when privacy settings say so.
        </p>
      ) : parsed.files.length === 0 ? (
        <p className="p-4 text-xs text-fg-muted">This side changed nothing in the workspace.</p>
      ) : (
        <div>
          {parsed.files.map((file, index) => (
            <FileBlock key={`${file.path}-${index}`} file={file} defaultOpen={index < 2} />
          ))}
        </div>
      )}

      {parsed.truncated ? (
        <p className="border-t border-border px-3 py-2 text-2xs text-warn">
          The diff was longer than the render limit and was cut off. The full patch is in the local battle
          directory.
        </p>
      ) : null}
    </section>
  );
}
