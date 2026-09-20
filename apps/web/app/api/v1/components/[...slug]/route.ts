/**
 * Read one component. A component slug is `<kind>/<name>` and contains a slash, hence the catch-all.
 * Public read, no auth.
 */
import { componentDetailResponseSchema } from '@harness-arena/protocol';
import { getComponent } from '@harness-arena/database';
import { apiError, apiJson } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string[] }>;
}

export async function GET(_request: Request, ctx: Context): Promise<Response> {
  const { slug } = await ctx.params;
  const componentSlug = slug.join('/');

  const dbh = await db();
  const component = await getComponent(dbh, componentSlug);
  if (!component) return apiError('not_found', 'no component with that slug');

  return apiJson(componentDetailResponseSchema.parse({ component }));
}
