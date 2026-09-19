import { meResponseSchema } from '@harness-arena/protocol';
import { apiJson, requireDevice } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Who the device token belongs to. Used by `arena whoami` and by the CLI after login. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireDevice(request);
  if (!auth.ok) return auth.response;
  const { user, device } = auth.auth;

  const body = meResponseSchema.parse({
    user: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl },
    device: { id: device.id, name: device.name, createdAt: device.createdAt.toISOString() },
  });
  return apiJson(body);
}
