import { uploadArtifactRequestSchema } from '@harness-arena/protocol';
import { upsertArtifact } from '@harness-arena/database';
import { apiError, apiJson, parseWith, readJsonBody, requireDevice } from '@/lib/api';
import { ownedBattle } from '@/lib/battles';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Upload one artifact (diff, final response, or rendered report). Re-uploading replaces it. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseWith(uploadArtifactRequestSchema, body.value);
  if (!parsed.ok) return parsed.response;

  const dbh = await db();
  const owned = await ownedBattle(dbh, id, auth.auth.user.id);
  if (!owned.ok) {
    return owned.code === 'not_found'
      ? apiError('not_found', 'no battle with that id')
      : apiError('forbidden', 'that battle belongs to another account');
  }

  const artifact = await upsertArtifact(dbh, {
    battleId: id,
    side: parsed.data.side,
    kind: parsed.data.kind,
    content: parsed.data.content,
    contentType: parsed.data.contentType,
  });
  return apiJson({ kind: artifact.kind, side: artifact.side, bytes: artifact.bytes }, 201);
}
