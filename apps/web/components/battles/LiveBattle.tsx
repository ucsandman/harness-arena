'use client';

import { useEffect, useRef, useState } from 'react';
import {
  battleRecordSchema,
  safeParseEvent,
  type ArenaEvent,
  type BattleRecord,
} from '@harness-arena/protocol';
import { BattleReport } from '@/components/battle/BattleReport';
import { Badge } from '@/components/ui/Badge';

type Connection = 'connecting' | 'live' | 'ended' | 'error';

const LABEL: Record<Connection, { text: string; variant: 'accent' | 'neutral' | 'warn' | 'success' }> = {
  connecting: { text: 'connecting to the live stream', variant: 'neutral' },
  live: { text: 'live', variant: 'accent' },
  ended: { text: 'stream finished', variant: 'success' },
  error: { text: 'live stream disconnected; reload for the latest', variant: 'warn' },
};

/**
 * A running battle, refreshed from the SSE endpoint. The first paint is exactly the server-rendered
 * report (state starts from the props), so hydration matches; appended events and the newest record
 * arrive afterwards. Every frame is validated against the protocol schema before it is rendered.
 */
export function LiveBattle({
  initialRecord,
  initialEvents,
  streamUrl,
}: {
  initialRecord: BattleRecord;
  initialEvents: ArenaEvent[];
  streamUrl: string;
}) {
  const [record, setRecord] = useState<BattleRecord>(initialRecord);
  const [events, setEvents] = useState<ArenaEvent[]>(initialEvents);
  const [connection, setConnection] = useState<Connection>('connecting');
  const lastSeq = useRef<number>(
    initialEvents.length > 0 ? (initialEvents[initialEvents.length - 1]?.seq ?? -1) : -1,
  );

  useEffect(() => {
    const url = lastSeq.current >= 0 ? `${streamUrl}?after=${lastSeq.current}` : streamUrl;
    const source = new EventSource(url);

    source.onopen = () => setConnection('live');
    source.onerror = () => setConnection((current) => (current === 'ended' ? current : 'error'));

    source.addEventListener('event', (message) => {
      const parsed = safeParseEvent(readJson((message as MessageEvent<string>).data));
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.seq <= lastSeq.current) return;
      lastSeq.current = event.seq;
      setEvents((current) => [...current, event]);
      setConnection('live');
    });

    source.addEventListener('record', (message) => {
      const parsed = battleRecordSchema.safeParse(readJson((message as MessageEvent<string>).data));
      if (parsed.success) setRecord(parsed.data);
    });

    source.addEventListener('end', () => {
      setConnection('ended');
      source.close();
    });

    return () => source.close();
  }, [streamUrl]);

  const label = LABEL[connection];
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-2xs text-fg-muted" aria-live="polite">
        <Badge variant={label.variant}>{label.text}</Badge>
        <span className="font-mono">{events.length} events received</span>
      </p>
      <BattleReport record={record} events={events} />
    </div>
  );
}

function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
