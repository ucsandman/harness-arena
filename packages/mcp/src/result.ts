import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Every tool answers twice: one short human sentence a person can read in a transcript, then the
 * structured JSON an LLM should act on. The same object is also attached as `structuredContent` for
 * clients that read it.
 */

/** A single JSON payload larger than this is refused with guidance instead of flooding the client. */
export const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function jsonResult(summary: string, data: Record<string, unknown>): CallToolResult {
  const json = JSON.stringify(data, null, 2);
  // UTF-8 bytes, not characters: one CJK character or emoji costs 3-4 bytes, so a length check
  // under-counts a payload by up to 4x and the advertised cap would not hold.
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_JSON_BYTES) {
    return errorResult(
      'the result is ' +
        Math.round(bytes / 1024) +
        ' KB, over the ' +
        Math.round(MAX_JSON_BYTES / 1024) +
        ' KB limit for one call. Ask again with a smaller limit, or narrow eventTypes.',
    );
  }
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: json },
    ],
    structuredContent: data,
  };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** zod 4 issue list -> one line the caller can fix. */
export function issueText(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((i) => (i.path.join('.') || '(root)') + ': ' + i.message).join('; ');
}
