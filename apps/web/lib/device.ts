import { listDevices, type ArenaDatabase, type DeviceCode } from '@harness-arena/database';

/**
 * Device-login bookkeeping.
 *
 * A device token is returned to the CLI exactly once. The `device_codes` table has no "consumed"
 * state (its status enum is pending | approved | denied | expired) and `devices` has no reference
 * back to the code, so the issued device carries the code id in its scopes and that marker is the
 * record of consumption. See openIssues: a `device_code_id` column on `devices` would replace this.
 */

export const DEVICE_BASE_SCOPES = ['battles:write'] as const;

export function consumedMarker(deviceCodeId: string): string {
  return `code:${deviceCodeId}`;
}

export function scopesForDevice(deviceCodeId: string): string[] {
  return [...DEVICE_BASE_SCOPES, consumedMarker(deviceCodeId)];
}

/** True when a token was already issued for this code, so the poll must not hand out a second one. */
export async function codeAlreadyConsumed(db: ArenaDatabase, code: DeviceCode): Promise<boolean> {
  if (!code.userId) return false;
  const marker = consumedMarker(code.id);
  const devices = await listDevices(db, code.userId);
  return devices.some((device) => device.scopes.includes(marker));
}

/** Scopes worth showing a human: the bookkeeping marker is not one of them. */
export function displayScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !scope.startsWith('code:'));
}
