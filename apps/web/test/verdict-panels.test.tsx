import './setup-env';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { INTEGRITY_LABELS } from '@harness-arena/protocol';
import { IntegrityPanel } from '../components/battle/IntegrityPanel';
import { VerdictBanner } from '../components/battle/VerdictBanner';
import { demoRecord } from './helpers';

describe('IntegrityPanel', () => {
  it('says a battle predates the integrity checks when integrity is null', () => {
    const record = demoRecord();
    expect(record.integrity).toBeNull();
    const html = renderToStaticMarkup(<IntegrityPanel record={record} />);
    expect(html).toContain('predates the integrity checks');
  });

  it('renders "Not rated because" plus the block flag label', () => {
    const record = demoRecord({
      integrity: {
        eligible: false,
        flags: [{ code: 'demo', severity: 'block', detail: 'Demo data: deterministic fixtures.', side: null }],
        fingerprint: null,
        checkedWith: 'test-suite',
      },
    });
    const html = renderToStaticMarkup(<IntegrityPanel record={record} />);
    expect(html).toContain('Not rated because');
    expect(html).toContain(INTEGRITY_LABELS.demo.charAt(0).toLowerCase() + INTEGRITY_LABELS.demo.slice(1));
  });
});

describe('VerdictBanner stage table', () => {
  it('renders the verdict stage table for the demo record', () => {
    const record = demoRecord();
    expect(record.verdict?.breakdown.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<VerdictBanner record={record} />);
    expect(html).toContain('Completion');
  });
});
