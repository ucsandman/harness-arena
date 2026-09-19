import { EVENT_LIMITS, type BattleStatus } from '@harness-arena/protocol';
import { getBattle, getBattleForViewer, listEvents } from '@harness-arena/database';
import { apiError, optionalViewer } from '@/lib/api';
import { eventRowToEvent } from '@/lib/battles';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Server-sent events for a live battle, backed by polling the events table by sequence number. No
 * broker and no shared in-memory fan-out, so it behaves the same on a long-lived Node server and on a
 * serverless instance (docs/ARCHITECTURE.md, "Web app and realtime").
 *
 * Frames: `event` (one protocol event), `record` (the battle record changed), `heartbeat`, `end`.
 */
const POLL_MS = 1500;
const HEARTBEAT_MS = 15_000;
const EVENTS_PER_POLL = EVENT_LIMITS.maxBatchEvents;
/** polls with no new events after a terminal status before the stream says goodbye */
const IDLE_POLLS_BEFORE_END = 2;

const TERMINAL: ReadonlySet<BattleStatus> = new Set<BattleStatus>(['completed', 'failed', 'cancelled']);

function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const viewer = await optionalViewer(request);
  const dbh = await db();

  const visible = await getBattleForViewer(dbh, id, viewer.userId);
  if (!visible) return apiError('not_found', 'no battle with that id is visible to you');

  // an absent (or empty) ?after= resumes from before seq 0; reading it as 0 would skip that event
  const afterRaw = new URL(request.url).searchParams.get('after');
  const afterParam = afterRaw === null || afterRaw === '' ? Number.NaN : Number(afterRaw);
  let lastSeq = Number.isFinite(afterParam) && afterParam >= 0 ? Math.floor(afterParam) : -1;
  let lastRecordAt = 0;
  let closed = false;

  const encoder = new TextEncoder();
  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the consumer
        }
      };
      const onAbort = (): void => finish();
      signal.addEventListener('abort', onAbort, { once: true });

      void (async () => {
        let idlePolls = 0;
        let lastHeartbeat = Date.now();
        // an initial comment opens the stream through proxies and sets the client's retry delay
        send(`retry: 3000\n: open\n\n`);
        try {
          while (!closed && !signal.aborted) {
            const current = await getBattle(dbh, id);
            if (!current) {
              send(frame('end', { reason: 'deleted' }));
              break;
            }
            const rows = await listEvents(dbh, id, {
              limit: EVENTS_PER_POLL,
              ...(lastSeq >= 0 ? { afterSeq: lastSeq } : {}),
            });
            for (const row of rows) {
              lastSeq = row.seq;
              const event = eventRowToEvent(row);
              if (event) send(frame('event', event));
            }

            const updatedAt = current.battle.updatedAt.getTime();
            if (updatedAt !== lastRecordAt) {
              lastRecordAt = updatedAt;
              send(frame('record', current.battle.record));
            }

            idlePolls = rows.length === 0 ? idlePolls + 1 : 0;
            if (TERMINAL.has(current.battle.status) && idlePolls >= IDLE_POLLS_BEFORE_END) {
              send(frame('end', { status: current.battle.status }));
              break;
            }
            if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
              lastHeartbeat = Date.now();
              send(frame('heartbeat', { at: new Date().toISOString() }));
            }
            // a backlog is drained without waiting; otherwise poll on the interval
            if (rows.length < EVENTS_PER_POLL) await sleep(POLL_MS, signal);
          }
        } catch {
          send(frame('end', { reason: 'error' }));
        } finally {
          signal.removeEventListener('abort', onAbort);
          finish();
        }
      })();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
