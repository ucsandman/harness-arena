import type { BattleRecord } from '@harness-arena/protocol';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { absoluteUrl } from '@/lib/env';

/** Copy-pasteable links for a public battle: the page URL, its OG image, and a README badge. */
export function ShareBlock({
  record,
  winnerSlug,
}: {
  record: BattleRecord;
  winnerSlug: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Share this battle</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <CodeBlock filename="battle URL" code={absoluteUrl(`/battles/${record.id}`)} />
        <CodeBlock filename="OG image" code={absoluteUrl(`/battles/${record.id}/opengraph-image?v=1`)} />
        {winnerSlug ? (
          <CodeBlock
            filename="README badge"
            language="markdown"
            code={`[![Harness Arena](${absoluteUrl(`/api/v1/badges/${winnerSlug}/rating`)})](${absoluteUrl(`/harnesses/${winnerSlug}`)})`}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}
