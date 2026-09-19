import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '@harness-arena/adapters';
import type { Redactor } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface LoggerOptions {
  level: LogLevel;
  /** receives one NDJSON line per record, without the trailing newline */
  sink?: (line: string) => void;
  /** also write a short human-readable line to stderr */
  pretty?: boolean;
  /** append NDJSON to this file; parent directories are created on first write */
  file?: string;
  /** scrubs secrets out of the message and data before anything is written */
  redactor?: Redactor;
  bindings?: Record<string, unknown>;
}

const PRETTY_TAG: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: 'debug',
  info: 'info ',
  warn: 'warn ',
  error: 'error',
};

/**
 * Structured logger. Every record is one NDJSON line `{ts, level, msg, ...bindings, ...data}`.
 * Callers must never pass environment values or prompt bodies at info level; the redactor is a
 * safety net, not a licence.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[opts.level];
  let dirReady = !opts.file;

  function ensureDir(file: string): void {
    if (dirReady) return;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    dirReady = true;
  }

  function make(bindings: Record<string, unknown>): Logger {
    function write(level: Exclude<LogLevel, 'silent'>, msg: string, data?: Record<string, unknown>): void {
      if (LEVEL_ORDER[level] < threshold) return;
      const safeMsg = opts.redactor ? opts.redactor.redactString(msg) : msg;
      const safeData = data && opts.redactor ? opts.redactor.redactValue(data) : data;
      const merged = { ...bindings, ...(safeData ?? {}) };
      const ts = new Date().toISOString();
      let line: string;
      try {
        line = JSON.stringify({ ts, level, msg: safeMsg, ...merged });
      } catch {
        line = JSON.stringify({ ts, level, msg: safeMsg, logError: 'record is not serializable' });
      }
      opts.sink?.(line);
      if (opts.file) {
        try {
          ensureDir(opts.file);
          fs.appendFileSync(opts.file, line + '\n');
        } catch {
          // A broken log file must never break a battle.
        }
      }
      if (opts.pretty) {
        const extras = Object.entries(merged)
          .map(([k, v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v)))
          .join(' ');
        process.stderr.write(PRETTY_TAG[level] + ' ' + safeMsg + (extras ? ' ' + extras : '') + '\n');
      }
    }

    return {
      debug: (msg, data) => write('debug', msg, data),
      info: (msg, data) => write('info', msg, data),
      warn: (msg, data) => write('warn', msg, data),
      error: (msg, data) => write('error', msg, data),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  }

  return make(opts.bindings ?? {});
}

/** A logger that discards everything. Used as the default inside the engine. */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'silent' });
}
