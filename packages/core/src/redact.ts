import type { ArenaEvent } from '@harness-arena/protocol';

/**
 * Secret scrubbing. Everything that leaves the engine (events, artifacts, logs, uploads) passes
 * through a redactor first. Patterns are deliberately conservative: a false negative is a leak, but
 * a false positive on a short value makes a report useless, so minimum lengths are enforced.
 */

export const REDACTED = '[REDACTED]';

/** Minimum length for a value to be treated as a secret worth scrubbing. */
export const MIN_SECRET_LENGTH = 8;

export interface RedactorOptions {
  /** exact values (usually environment variable values) replaced wherever they appear */
  envValues?: string[];
  /** caller-supplied extra patterns; recompiled with the global flag */
  extraPatterns?: RegExp[];
}

export interface Redactor {
  redactString(s: string): string;
  redactValue<T>(v: T): T;
  redactEvent(e: ArenaEvent): ArenaEvent;
  /** how many exact values and patterns this redactor watches; shown in the report footer */
  size(): { values: number; patterns: number };
}

/** Token shapes recognised wherever they appear. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // AWS access key ids
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  // GitHub personal access / OAuth / user / server / refresh tokens
  /\bgh[pousr]_[A-Za-z0-9]{16,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
  // OpenAI / Anthropic style keys (sk-..., sk-ant-...)
  /\bsk-(?:ant-)?[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JWTs: the header segment is always the base64url of a JSON object, so it starts with eyJ
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  // PEM private key blocks
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
];

/** `Authorization: Bearer <token>` and friends: keep the scheme, drop the credential. */
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/** `API_KEY=...`, `--token abc`, `"password": "abc"` — keyed by a secret-ish name. */
const SECRET_NAME_CORE = '(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)';
const KEY_VALUE_PATTERN = new RegExp(
  '([A-Za-z0-9_.\\-]*' + SECRET_NAME_CORE + '[A-Za-z0-9_.\\-]*)(["\']?\\s*[:=]\\s*["\']?)([^\\s"\',;]{4,})',
  'gi',
);

const SECRET_NAME_RE = new RegExp(SECRET_NAME_CORE, 'i');
const SECRET_NAME_EXTRA_RE = /(^|_)(credential|credentials|auth|session|cookie|pass)(_|$)/i;

/** Names whose values are paths, flags or other non-secrets even when they look random. */
const NAME_DENY_RE =
  /(^|_)(path|pathext|home|userprofile|temp|tmp|tmpdir|cwd|pwd|dir|shell|lang|term|editor|pager|hostname|username|user|logname|os|arch)(_|$)/i;
const NAME_DENY_SUFFIX_RE = /(_file|_path|_dir|_home|_url|_uri|_host|_port|_region|_bucket|_id|_version)$/i;
const OBVIOUS_NON_SECRET_RE =
  /^(?:true|false|yes|no|on|off|none|null|undefined|\d+(?:\.\d+)*|[A-Za-z]{1,4})$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeToken(value: string): boolean {
  return TOKEN_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(value);
  });
}

/**
 * Pick environment values worth scrubbing: either the NAME says secret, or the VALUE matches a
 * known token shape. PATH-like names and obvious non-secrets are excluded so reports stay readable.
 * Values are returned longest-first so a token containing another token is replaced whole.
 */
export function collectSecretEnvValues(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value.length < MIN_SECRET_LENGTH) continue;
    if (OBVIOUS_NON_SECRET_RE.test(value)) continue;
    if (NAME_DENY_RE.test(name) || NAME_DENY_SUFFIX_RE.test(name)) continue;
    const nameSaysSecret = SECRET_NAME_RE.test(name) || SECRET_NAME_EXTRA_RE.test(name);
    if (nameSaysSecret || looksLikeToken(value)) out.add(value);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const unique = [
    ...new Set(
      (opts.envValues ?? [])
        .filter((v): v is string => typeof v === 'string' && v.trim().length >= MIN_SECRET_LENGTH)
        .map((v) => v.trim()),
    ),
  ].sort((a, b) => b.length - a.length);
  const valueRes = unique.map((v) => new RegExp(escapeRegExp(v), 'g'));
  const extra = (opts.extraPatterns ?? []).map(
    (p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'),
  );

  function redactString(s: string): string {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = s;
    for (const re of valueRes) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
    for (const re of [...TOKEN_PATTERNS, ...extra]) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
    AUTH_HEADER_PATTERN.lastIndex = 0;
    out = out.replace(AUTH_HEADER_PATTERN, (_match, scheme: string) => scheme + ' ' + REDACTED);
    KEY_VALUE_PATTERN.lastIndex = 0;
    out = out.replace(KEY_VALUE_PATTERN, (match: string, key: string, sep: string, value: string) =>
      value === REDACTED ? match : key + sep + REDACTED,
    );
    return out;
  }

  function walk(v: unknown): unknown {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date) return v;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  }

  return {
    redactString,
    redactValue: <T>(v: T): T => walk(v) as T,
    // Envelope identity and ordering fields are Arena's own; only payload and source can carry data.
    redactEvent: (e) => ({ ...e, payload: walk(e.payload), source: walk(e.source) }) as ArenaEvent,
    size: () => ({ values: unique.length, patterns: TOKEN_PATTERNS.length + extra.length + 2 }),
  };
}

/** A redactor that changes nothing, for `privacy.redact === false` on a local-only battle. */
export function createPassthroughRedactor(): Redactor {
  return {
    redactString: (s) => s,
    redactValue: <T>(v: T): T => v,
    redactEvent: (e) => e,
    size: () => ({ values: 0, patterns: 0 }),
  };
}
