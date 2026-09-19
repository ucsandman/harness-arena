import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../src/types';

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  data?: Record<string, unknown>;
}

export interface RecordingLogger extends Logger {
  records: LogRecord[];
  messages(level?: LogRecord['level']): string[];
}

export function createRecordingLogger(records: LogRecord[] = []): RecordingLogger {
  const push = (level: LogRecord['level']) => (msg: string, data?: Record<string, unknown>) => {
    records.push(data === undefined ? { level, msg } : { level, msg, data });
  };
  const logger: RecordingLogger = {
    records,
    messages(level) {
      return records.filter((r) => level === undefined || r.level === level).map((r) => r.msg);
    },
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child() {
      return logger;
    },
  };
  return logger;
}

export async function makeTempDir(prefix = 'arena-harness-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Write a set of relative POSIX paths with their contents, creating parent directories. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

/** A fetch stub: no network, records every call. */
export function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
  calls: FetchCall[] = [],
): { fetchImpl: typeof globalThis.fetch; calls: FetchCall[] } {
  const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/**
 * Create a symlink, returning false when the platform refuses (Windows without the privilege). A
 * directory link falls back to a junction, which Windows allows without any privilege and which
 * `lstat` also reports as a symbolic link, so the guards under test are exercised there too.
 */
export async function trySymlink(target: string, linkPath: string, type: 'file' | 'dir'): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type === 'dir' ? 'dir' : 'file');
    return true;
  } catch {
    if (type !== 'dir') return false;
    try {
      await fs.symlink(target, linkPath, 'junction');
      return true;
    } catch {
      return false;
    }
  }
}
