import {
  API_LIMITS,
  EVENT_LIMITS,
  createBattleResponseSchema,
  ingestEventsRequestSchema,
  patchBattleRequestSchema,
  uploadArtifactRequestSchema,
} from '@harness-arena/protocol';
import type { ArenaEvent, BattleRecord, PrivacySettings, Side } from '@harness-arena/protocol';
import type { Logger } from '@harness-arena/adapters';
import { ARENA_VERSION } from './version.js';

/**
 * Optional upload to the web app. Three promises to the engine:
 *
 *  1. it never throws — a battle must not fail because a server is down;
 *  2. it never sends more than `privacy.upload` allows, and honours every exclusion;
 *  3. nothing it sends contains a provider credential (the engine redacts before it gets here).
 */

export type ArtifactKind = 'diff' | 'final_response' | 'report_html';

export interface CreatedBattle {
  id: string;
  url: string;
  streamUrl: string;
}

export interface UploadStats {
  batches: number;
  events: number;
  artifacts: number;
  records: number;
  /** requests that failed after all retries */
  failures: number;
  /** payloads skipped because of the privacy level */
  skipped: number;
}

export interface Uploader {
  /** null when uploading is off, so callers never print a fabricated URL */
  createBattle(record: BattleRecord): Promise<CreatedBattle | null>;
  pushEvents(battleId: string, events: readonly ArenaEvent[]): Promise<void>;
  patchRecord(battleId: string, record: BattleRecord): Promise<void>;
  uploadArtifact(battleId: string, side: Side | null, kind: ArtifactKind, content: string): Promise<void>;
  flush(): Promise<void>;
  stats(): UploadStats;
}

export interface UploaderOptions {
  serverUrl: string;
  token: string;
  privacy: PrivacySettings;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** base delay for the retry backoff; three attempts total */
  retryBaseMs?: number;
  arenaVersion?: string;
}

const MAX_ATTEMPTS = 3;

function emptyStats(): UploadStats {
  return { batches: 0, events: 0, artifacts: 0, records: 0, failures: 0, skipped: 0 };
}

function createNoopUploader(): Uploader {
  const stats = emptyStats();
  return {
    createBattle: async () => {
      stats.skipped += 1;
      return null;
    },
    pushEvents: async () => {
      stats.skipped += 1;
    },
    patchRecord: async () => {
      stats.skipped += 1;
    },
    uploadArtifact: async () => {
      stats.skipped += 1;
    },
    flush: async () => {},
    stats: () => ({ ...stats }),
  };
}

/** Strip artifacts the privacy level or exclusions forbid, and the local-only raw log path. */
export function sanitizeRecordForUpload(record: BattleRecord, privacy: PrivacySettings): BattleRecord {
  const exclude = new Set(privacy.exclude);
  const full = privacy.upload === 'full';
  const clone = JSON.parse(JSON.stringify(record)) as BattleRecord;
  for (const side of ['a', 'b'] as const) {
    const artifacts = clone.runs[side].artifacts;
    delete artifacts.rawLogPath;
    if (!full || exclude.has('diffs')) {
      artifacts.diff = null;
      delete artifacts.diffBytes;
    }
    if (!full || exclude.has('model_outputs')) artifacts.finalResponse = null;
    if (exclude.has('paths')) {
      clone.runs[side].artifacts.changedFiles = artifacts.changedFiles.map((f) => ({
        ...f,
        path: '[excluded]',
      }));
    }
  }
  return clone;
}

export function createUploader(opts: UploaderOptions): Uploader {
  if (opts.privacy.upload === 'none') return createNoopUploader();

  const level = opts.privacy.upload;
  const exclude = new Set(opts.privacy.exclude);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = opts.serverUrl.replace(/\/+$/, '');
  const version = opts.arenaVersion ?? ARENA_VERSION;
  const retryBaseMs = opts.retryBaseMs ?? 200;
  const stats = emptyStats();
  const log = opts.logger;
  let chain: Promise<void> = Promise.resolve();

  function headers(): Record<string, string> {
    return {
      authorization: 'Bearer ' + opts.token,
      'content-type': 'application/json',
      'user-agent': 'harness-arena/' + version,
      accept: 'application/json',
    };
  }

  async function request(
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; json: unknown }> {
    const url = base + path;
    let lastStatus = 0;
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetchImpl(url, { method, headers: headers(), body: JSON.stringify(body) });
        lastStatus = response.status;
        if (response.ok) {
          let json: unknown = null;
          try {
            json = await response.json();
          } catch {
            json = null;
          }
          return { ok: true, status: response.status, json };
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          log.warn('upload rejected', { path, status: response.status });
          stats.failures += 1;
          return { ok: false, status: response.status, json: null };
        }
        lastError = 'status ' + response.status;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, retryBaseMs * attempt));
    }
    stats.failures += 1;
    log.warn('upload failed after retries', {
      path,
      attempts: MAX_ATTEMPTS,
      status: lastStatus,
      reason: lastError,
    });
    return { ok: false, status: lastStatus, json: null };
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    chain = chain.then(work, work);
    return chain;
  }

  return {
    async createBattle(record) {
      const body = {
        record: sanitizeRecordForUpload(record, opts.privacy),
        visibility: record.spec.visibility,
      };
      const result = await request('POST', '/api/v1/battles', body);
      if (!result.ok) return null;
      const parsed = createBattleResponseSchema.safeParse(result.json);
      if (!parsed.success) {
        log.warn('upload: the server returned an unexpected create-battle response');
        stats.failures += 1;
        return null;
      }
      stats.records += 1;
      return parsed.data;
    },

    pushEvents(battleId, events) {
      if (level === 'metrics') {
        stats.skipped += events.length;
        return Promise.resolve();
      }
      if (events.length === 0) return Promise.resolve();
      const batches: ArenaEvent[][] = [];
      for (let i = 0; i < events.length; i += EVENT_LIMITS.maxBatchEvents) {
        batches.push(events.slice(i, i + EVENT_LIMITS.maxBatchEvents) as ArenaEvent[]);
      }
      return enqueue(async () => {
        for (const batch of batches) {
          const body = ingestEventsRequestSchema.safeParse({ events: batch });
          if (!body.success) {
            log.warn('upload: dropped a batch that does not match the event schema', { count: batch.length });
            stats.failures += 1;
            continue;
          }
          const result = await request('POST', '/api/v1/battles/' + battleId + '/events', body.data);
          stats.batches += 1;
          if (result.ok) stats.events += batch.length;
        }
      });
    },

    patchRecord(battleId, record) {
      return enqueue(async () => {
        const body = patchBattleRequestSchema.safeParse({
          record: sanitizeRecordForUpload(record, opts.privacy),
          status: record.status,
        });
        if (!body.success) {
          log.warn('upload: the record does not match the API schema, not patched');
          stats.failures += 1;
          return;
        }
        const result = await request('PATCH', '/api/v1/battles/' + battleId, body.data);
        if (result.ok) stats.records += 1;
      });
    },

    uploadArtifact(battleId, side, kind, content) {
      if (level !== 'full') {
        stats.skipped += 1;
        return Promise.resolve();
      }
      if (kind === 'diff' && exclude.has('diffs')) {
        stats.skipped += 1;
        return Promise.resolve();
      }
      if (kind === 'final_response' && exclude.has('model_outputs')) {
        stats.skipped += 1;
        return Promise.resolve();
      }
      const trimmed =
        content.length > API_LIMITS.maxArtifactBytes
          ? content.slice(0, API_LIMITS.maxArtifactBytes)
          : content;
      return enqueue(async () => {
        const body = uploadArtifactRequestSchema.safeParse({
          side,
          kind,
          content: trimmed,
          contentType: kind === 'report_html' ? 'text/html' : 'text/plain',
        });
        if (!body.success) {
          log.warn('upload: artifact does not match the API schema', { kind });
          stats.failures += 1;
          return;
        }
        const result = await request('POST', '/api/v1/battles/' + battleId + '/artifacts', body.data);
        if (result.ok) stats.artifacts += 1;
      });
    },

    async flush() {
      await chain;
    },

    stats: () => ({ ...stats }),
  };
}
