import type { BattleRecord } from '@harness-arena/protocol';
import { INTEGRITY_LABELS } from '@harness-arena/protocol';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TBody, TD, TH, THead, TR, TableWrap } from '@/components/ui/Table';

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

/** Rating eligibility and the checks that produced it, straight from the record's stored report. */
export function IntegrityPanel({ record }: { record: BattleRecord }) {
  const integrity = record.integrity;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Integrity checks</CardTitle>
      </CardHeader>
      <CardBody>
        {integrity === null ? (
          <p className="text-[0.8125rem] text-fg-muted">
            This battle predates the integrity checks and was not gated by them.
          </p>
        ) : (
          <>
            {integrity.eligible ? (
              <Badge variant="success">Eligible for ratings</Badge>
            ) : (
              <Badge variant="danger">
                Not rated because{' '}
                {integrity.flags
                  .filter((flag) => flag.severity === 'block')
                  .map((flag) => lowerFirst(INTEGRITY_LABELS[flag.code]))
                  .join(', ')}
              </Badge>
            )}

            <div className="mt-3">
              {integrity.flags.length === 0 ? (
                <p className="text-[0.8125rem] text-fg-muted">No check fired.</p>
              ) : (
                <TableWrap>
                  <Table caption="Integrity flags">
                    <THead>
                      <TR>
                        <TH>Check</TH>
                        <TH>Severity</TH>
                        <TH>Side</TH>
                        <TH>Detail</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {integrity.flags.map((flag, index) => (
                        <TR key={`${flag.code}-${index}`}>
                          <TD>{INTEGRITY_LABELS[flag.code]}</TD>
                          <TD>
                            {flag.severity === 'block' ? (
                              <Badge variant="danger">block</Badge>
                            ) : (
                              <Badge variant="warn">warn</Badge>
                            )}
                          </TD>
                          <TD mono>{flag.side ? flag.side.toUpperCase() : '—'}</TD>
                          <TD className="text-fg-muted">{flag.detail}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableWrap>
              )}
            </div>

            <p className="mt-3 text-2xs text-fg-subtle">
              Checked with {integrity.checkedWith}
              {integrity.fingerprint ? (
                <>
                  {' '}
                  · matchup fingerprint used to detect duplicates:{' '}
                  <span className="font-mono">{integrity.fingerprint.slice(0, 12)}</span>
                </>
              ) : null}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
