import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSilentLogger } from '@harness-arena/core';
import { createArenaMcpServer } from '../src/server.js';
import type { ArenaMcpServer, ArenaMcpServerOptions } from '../src/server.js';

/** Anything parsed out of a tool's JSON block. Tests assert on it field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mcp-' + label + '-'));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

export interface Connected {
  client: Client;
  arena: ArenaMcpServer;
  close(): Promise<void>;
}

/** A client and a server talking over a linked in-memory transport pair. */
export async function connect(opts: ArenaMcpServerOptions): Promise<Connected> {
  const arena = createArenaMcpServer({ logger: createSilentLogger(), ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'harness-arena-test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), arena.server.connect(serverTransport)]);
  return {
    client,
    arena,
    async close() {
      await client.close();
      await arena.close();
    },
  };
}

export interface ToolAnswer {
  isError: boolean;
  /** first content block: the one-line human summary */
  summary: string;
  /** every text block joined, for substring assertions */
  text: string;
  /** the second content block, parsed; null on an error result */
  data: Json;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '');
  const isError = result.isError === true;
  return {
    isError,
    summary: texts[0] ?? '',
    text: texts.join('\n'),
    data: isError || texts.length < 2 ? null : (JSON.parse(texts[1] as string) as Json),
  };
}

/**
 * Copies the committed demo battle (examples/demo) into a temp ARENA_HOME so the read tools can be
 * tested against a real record without running anything.
 */
export function seedExportedBattle(home: string): { id: string; events: number } {
  const source = path.join(REPO_ROOT, 'examples', 'demo');
  const record = JSON.parse(fs.readFileSync(path.join(source, 'battle.json'), 'utf8')) as { id: string };
  const ndjson = fs.readFileSync(path.join(source, 'events.ndjson'), 'utf8');
  const dir = path.join(home, 'battles', record.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'battle.json'), JSON.stringify(record, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'events.ndjson'), ndjson);
  return { id: record.id, events: ndjson.split('\n').filter((l) => l.trim().length > 0).length };
}

export async function waitForStatus(
  client: Client,
  id: string,
  done: readonly string[],
  timeoutMs = 90_000,
): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  let last: Json = null;
  while (Date.now() < deadline) {
    const answer = await callTool(client, 'arena_get_battle', { id });
    if (!answer.isError) {
      last = answer.data;
      if (done.includes(String(last.status))) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('battle ' + id + ' did not reach ' + done.join('/') + '; last status ' + last?.status);
}
