import type { ZodError } from 'zod';

/**
 * Zod issues as one short line: field paths and messages only, never the submitted values.
 *
 * Kept in its own module with no other imports, because both the API layer (server only) and the
 * battle form (a client component) need it; pulling it from lib/api.ts would drag `next/headers`
 * into the client bundle.
 */
export function describeIssues(error: ZodError, limit = 5): string {
  return error.issues
    .slice(0, limit)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
