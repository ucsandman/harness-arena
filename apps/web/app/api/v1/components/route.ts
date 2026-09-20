/**
 * The component catalogue: the reusable parts a harness declares in arena.yaml. Public read, no auth.
 */
import {
  componentKindSchema,
  componentListResponseSchema,
  type ComponentKind,
} from '@harness-arena/protocol';
import { listComponents } from '@harness-arena/database';
import { apiError, apiJson } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function parseKind(
  url: URL,
): { ok: true; value: ComponentKind | undefined } | { ok: false; response: Response } {
  const raw = url.searchParams.get('kind');
  if (!raw) return { ok: true, value: undefined };
  const parsed = componentKindSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: apiError('invalid_request', `invalid kind "${raw}"`) };
  return { ok: true, value: parsed.data };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const kind = parseKind(url);
  if (!kind.ok) return kind.response;

  const limitParam = Number(url.searchParams.get('limit') ?? '');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : undefined;

  const dbh = await db();
  const components = await listComponents(dbh, { kind: kind.value, limit });
  return apiJson(componentListResponseSchema.parse({ components, count: components.length }));
}
