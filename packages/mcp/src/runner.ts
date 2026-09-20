import type { ArenaEvent, BattleRecord, BattleStatus } from '@harness-arena/protocol';
import { errorText } from './result.js';

const TERMINAL: ReadonlySet<BattleStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Tracks battles started through the MCP server, in memory, for this process only.
 *
 * One battle at a time: a battle saturates a machine's CPU and disk, and two concurrent runs would
 * make both sides' timings meaningless. A second start is refused and names the running battle so
 * the client can poll it instead. The battle record on disk is always the source of truth; this map
 * only carries what disk cannot answer yet (a battle that has not saved its final state).
 */

export interface BattleHandle {
  id: string;
  status: BattleStatus;
  /** the trust flag the caller passed to arena_start_battle */
  trusted: boolean;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface RunHooks {
  onEvent: (event: ArenaEvent) => void;
  onStatus: (status: BattleStatus) => void;
}

export interface StartInput {
  trusted: boolean;
  /** how long to wait for completion before answering; 0 answers as soon as the id is known */
  waitMs: number;
  run: (hooks: RunHooks) => Promise<BattleRecord>;
}

export type StartResult =
  | { kind: 'started'; handle: BattleHandle; finished: boolean }
  | { kind: 'busy'; runningId: string | null }
  | { kind: 'failed'; message: string };

interface Active {
  id: string | null;
  error: string | null;
  finished: boolean;
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export class BattleRunner {
  private readonly battles = new Map<string, BattleHandle>();
  private active: Active | null = null;
  private current: Promise<void> | null = null;

  /** id of the battle running in this process, or null. */
  get runningId(): string | null {
    return this.active?.id ?? null;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  get(id: string): BattleHandle | undefined {
    const handle = this.battles.get(id);
    return handle ? { ...handle } : undefined;
  }

  list(): BattleHandle[] {
    return [...this.battles.values()].map((h) => ({ ...h }));
  }

  /** Resolves when no battle is running, or after `timeoutMs`. */
  async idle(timeoutMs = 30_000): Promise<boolean> {
    const current = this.current;
    if (current === null) return true;
    const timer = delay(timeoutMs);
    const finished = await Promise.race([current.then(() => true), timer.promise.then(() => false)]);
    timer.cancel();
    return finished;
  }

  async start(input: StartInput): Promise<StartResult> {
    if (this.active !== null) return { kind: 'busy', runningId: this.active.id };

    const active: Active = { id: null, error: null, finished: false };
    this.active = active;

    let idSeen: () => void = () => {};
    const idReady = new Promise<void>((resolve) => {
      idSeen = resolve;
    });

    const finished = input
      .run({
        onEvent: (event) => {
          if (active.id !== null) return;
          this.register(event.battleId, input.trusted);
          active.id = event.battleId;
          idSeen();
        },
        onStatus: (status) => {
          // A terminal status arrives before the engine has written the report, uploaded and cleaned
          // the workspaces; the handle only turns terminal when the run promise settles below, so a
          // caller that sees a finished status can start the next battle at once.
          if (TERMINAL.has(status)) return;
          const handle = active.id === null ? undefined : this.battles.get(active.id);
          if (handle && handle.completedAt === null) handle.status = status;
        },
      })
      .then((record) => {
        if (active.id === null) {
          this.register(record.id, input.trusted);
          active.id = record.id;
        }
        const handle = this.battles.get(record.id);
        if (handle) {
          handle.status = record.status;
          handle.completedAt = record.completedAt ?? new Date().toISOString();
          handle.error = record.error;
        }
      })
      .catch((err: unknown) => {
        const message = errorText(err);
        active.error = message;
        const handle = active.id === null ? undefined : this.battles.get(active.id);
        if (handle) {
          handle.status = 'failed';
          handle.completedAt = new Date().toISOString();
          handle.error = message;
        }
      })
      .finally(() => {
        active.finished = true;
        this.active = null;
        this.current = null;
        idSeen();
      });

    this.current = finished;
    await Promise.race([idReady, finished]);

    if (active.id === null) {
      return {
        kind: 'failed',
        message: active.error ?? 'the battle stopped before it reported a battle id',
      };
    }

    if (input.waitMs > 0 && !active.finished) {
      const timer = delay(input.waitMs);
      await Promise.race([finished, timer.promise]);
      timer.cancel();
    }

    const handle = this.battles.get(active.id);
    return {
      kind: 'started',
      handle: handle ? { ...handle } : this.register(active.id, input.trusted),
      finished: active.finished,
    };
  }

  private register(id: string, trusted: boolean): BattleHandle {
    const existing = this.battles.get(id);
    if (existing) return existing;
    const handle: BattleHandle = {
      id,
      status: 'running',
      trusted,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    this.battles.set(id, handle);
    return handle;
  }
}
