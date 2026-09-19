import type { Device } from '@harness-arena/database';
import { Badge } from '@/components/ui/Badge';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';
import { DEVICE_TOKEN_PREFIX } from '@/lib/auth';
import { displayScopes } from '@/lib/device';
import { formatUtcDate, relativeTime } from '@/lib/format';
import { revokeDeviceAction } from '@/app/settings/actions';

/**
 * The machines that hold a CLI token. Only the token prefix is ever shown: the token itself was
 * returned to the CLI once and is stored as a hash.
 */
export function DeviceTable({ devices }: { devices: Device[] }) {
  if (devices.length === 0) {
    return (
      <p className="px-4 py-3 text-[0.8125rem] text-fg-muted">
        No device is connected. Run <span className="font-mono">arena login</span> on a machine and approve
        the code it prints.
      </p>
    );
  }

  return (
    <TableWrap>
      <Table caption="Connected devices">
        <THead>
          <TR>
            <TH>Device</TH>
            <TH>Token</TH>
            <TH>Scopes</TH>
            <TH>Created</TH>
            <TH>Last used</TH>
            <TH>
              <span className="sr-only">Revoke</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {devices.map((device) => {
            const revoked = device.revokedAt !== null;
            return (
              <TR key={device.id} className={revoked ? 'opacity-60' : undefined}>
                <TD>
                  <span className="flex items-center gap-2">
                    {device.name}
                    {revoked ? <Badge variant="neutral">revoked</Badge> : null}
                  </span>
                </TD>
                <TD mono>
                  {DEVICE_TOKEN_PREFIX}
                  {device.tokenPrefix}…
                </TD>
                <TD mono className="text-2xs">
                  {displayScopes(device.scopes).join(', ') || '—'}
                </TD>
                <TD>{formatUtcDate(device.createdAt.toISOString())}</TD>
                <TD>{device.lastUsedAt ? relativeTime(device.lastUsedAt.toISOString()) : 'never'}</TD>
                <TD>
                  {revoked ? null : (
                    <form action={revokeDeviceAction}>
                      <input type="hidden" name="deviceId" value={device.id} />
                      <button
                        type="submit"
                        className="h-7 rounded-md border border-danger-border bg-danger-subtle px-2.5 text-xs font-medium text-danger hover:opacity-90"
                      >
                        Revoke
                      </button>
                    </form>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </TableWrap>
  );
}
