import fs from 'node:fs';
import path from 'node:path';
import { battleSpecSchema, privacyExclusionSchema, visibilitySchema } from '@harness-arena/protocol';
import type { BattleSpec, BattleSpecInput, PrivacyExclusion, Visibility } from '@harness-arena/protocol';
import { CliError } from './errors.js';

/** Flag parsing and spec assembly. Pure: no filesystem writes, no network, no prompts. */

const DURATION_RE = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)?/gi;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * `20m`, `900s`, `1h30m`, `500ms`. A bare number is seconds (`--timeout 900` = 15 minutes).
 */
export function parseDuration(input: string, flag = '--timeout'): number {
  const text = input.trim().toLowerCase();
  if (text.length === 0) throw new CliError(flag + ' needs a duration like 20m, 900s or 1h30m');
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Math.round(Number(text) * 1000);
    if (seconds <= 0) throw new CliError(flag + ' must be greater than zero');
    return seconds;
  }
  let total = 0;
  let matched = 0;
  DURATION_RE.lastIndex = 0;
  let consumed = '';
  for (let m = DURATION_RE.exec(text); m !== null; m = DURATION_RE.exec(text)) {
    const amount = Number(m[1]);
    const unit = (m[2] ?? 's').toLowerCase();
    const factor = UNIT_MS[unit];
    if (factor === undefined || !Number.isFinite(amount)) break;
    total += amount * factor;
    matched += 1;
    consumed += m[0];
  }
  if (matched === 0 || consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) {
    throw new CliError(flag + ' could not be read as a duration: ' + input + ' (try 20m, 900s or 1h30m)');
  }
  const ms = Math.round(total);
  if (ms <= 0) throw new CliError(flag + ' must be greater than zero');
  return ms;
}

export function parsePositiveInt(input: string, flag: string): number {
  const value = Number(input.trim());
  if (!Number.isInteger(value) || value <= 0) throw new CliError(flag + ' must be a positive whole number');
  return value;
}

export function parsePositiveNumber(input: string, flag: string): number {
  const value = Number(input.trim());
  if (!Number.isFinite(value) || value <= 0) throw new CliError(flag + ' must be a positive number');
  return value;
}

export interface IssueRef {
  repo: string;
  number: number;
}

/** `owner/repo#123`, `owner/repo/issues/123`, a GitHub issue URL, or `123` with a GitHub --repo. */
export function parseIssueRef(value: string, repoFlag?: string): IssueRef {
  const text = value.trim();
  const url = /github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/i.exec(text);
  if (url) return { repo: url[1] + '/' + url[2], number: Number(url[3]) };
  const full = /^([\w.-]+)\/([\w.-]+)(?:#|\/issues\/)(\d+)$/.exec(text);
  if (full) return { repo: full[1] + '/' + full[2], number: Number(full[3]) };
  if (/^#?\d+$/.test(text)) {
    const repo = repoFromSource(repoFlag ?? '');
    if (!repo) {
      throw new CliError(
        '--issue ' +
          text +
          ' needs a GitHub repository: pass --repo https://github.com/owner/name or --issue owner/name#' +
          text.replace('#', ''),
      );
    }
    return { repo, number: Number(text.replace('#', '')) };
  }
  throw new CliError('--issue must look like owner/name#123 or a GitHub issue URL, got: ' + value);
}

/** "owner/name" for a GitHub repository source, else null. */
export function repoFromSource(source: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:$|[/#?])/.exec(source.trim());
  return m ? m[1] + '/' + m[2] : null;
}

export type UploadLevel = 'none' | 'metrics' | 'events' | 'full';

export function parseUploadLevel(value: string): UploadLevel {
  const text = value.trim().toLowerCase();
  if (text === 'none' || text === 'metrics' || text === 'events' || text === 'full') return text;
  throw new CliError('--upload must be none, metrics, events or full, got: ' + value);
}

export function parseExclusions(value: string): PrivacyExclusion[] {
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: PrivacyExclusion[] = [];
  for (const part of parts) {
    const parsed = privacyExclusionSchema.safeParse(part);
    if (!parsed.success) {
      throw new CliError(
        '--exclude does not know "' + part + '"; valid values: ' + privacyExclusionSchema.options.join(', '),
      );
    }
    if (!out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

export function parseVisibility(value: string): Visibility {
  const parsed = visibilitySchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) {
    throw new CliError('--visibility must be private, unlisted or public, got: ' + value);
  }
  return parsed.data;
}

export function readTaskFile(file: string, cwd: string): string {
  const abs = path.resolve(cwd, file);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new CliError('could not read the task file: ' + abs);
  }
  if (text.trim().length === 0) throw new CliError('the task file is empty: ' + abs);
  return text;
}

/** Validate a spec (filling every default) and report the failures the way the user wrote them. */
export function parseSpec(input: unknown, origin: string): BattleSpec {
  const parsed = battleSpecSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message)
      .join('; ');
    throw new CliError(origin + ' is not a valid battle spec: ' + detail);
  }
  return parsed.data;
}

export function readSpecFile(file: string, cwd: string): BattleSpecInput {
  const abs = path.resolve(cwd, file);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new CliError('could not read the battle spec: ' + abs);
  }
  try {
    return JSON.parse(raw) as BattleSpecInput;
  } catch (err) {
    throw new CliError(abs + ' is not valid JSON: ' + (err instanceof Error ? err.message : String(err)));
  }
}
