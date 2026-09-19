import { revokeDevice } from '@harness-arena/database';
import { apiError, apiJson, requireDevice } from '@/lib/api';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** `arena logout`: the calling device revokes itself. The token stops working immediately. */
export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;

  const dbh = await db();
  const revoked = await revokeDevice(dbh, auth.auth.user.id, auth.auth.device.id);
  if (!revoked) return apiError('not_found', 'this device is already revoked');
  return apiJson({ revoked: true, deviceId: auth.auth.device.id });
}
