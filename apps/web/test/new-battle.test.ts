import './setup-env';
import { describe, expect, it } from 'vitest';
import { specFromForm } from '@/lib/new-battle';
import { buildPendingRecord } from '@/lib/pending-battle';

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) data.append(key, item);
    else data.set(key, value);
  }
  return data;
}

describe('the /battles/new form', () => {
  it('builds a valid spec and a pending record from a prompt battle', () => {
    const built = specFromForm(
      form({
        title: 'Fix the flaky test',
        taskKind: 'prompt',
        prompt: 'Make the flaky test deterministic and explain why it flaked.',
        repositorySource: 'https://github.com/owner/repo',
        repositoryRef: 'main',
        agentA: 'claude-code',
        harnessA: 'vanilla',
        labelB: 'my harness',
        agentB: 'claude-code',
        modelB: 'opus-5',
        harnessB: 'https://github.com/owner/harness',
        timeoutMinutes: '30',
        maxTurns: '40',
        testsCommand: 'npm test',
        category: 'debugging',
        upload: 'events',
        exclude: ['diffs', 'paths'],
        visibility: 'unlisted',
        parallel: 'on',
        assertions: '[{"type":"file-exists","path":"README.md"}]',
      }),
    );

    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.errors.join('; '));
    const spec = built.spec;
    expect(spec.title).toBe('Fix the flaky test');
    expect(spec.task).toEqual({
      kind: 'prompt',
      prompt: 'Make the flaky test deterministic and explain why it flaked.',
    });
    expect(spec.limits.timeoutMs).toBe(1_800_000);
    expect(spec.limits.maxTurns).toBe(40);
    expect(spec.evaluation.tests?.command).toBe('npm test');
    expect(spec.evaluation.assertions).toEqual([{ type: 'file-exists', path: 'README.md' }]);
    expect(spec.privacy).toEqual({ upload: 'events', exclude: ['diffs', 'paths'], redact: true });
    expect(spec.visibility).toBe('unlisted');
    expect(spec.parallel).toBe(true);
    expect(spec.category).toBe('debugging');

    const record = buildPendingRecord(spec);
    expect(record.status).toBe('pending');
    expect(record.id.startsWith('btl_')).toBe(true);
    expect(record.runs.a.harness.kind).toBe('vanilla');
    expect(record.runs.b.label).toBe('my harness');
    expect(record.runs.b.agent.model).toBe('opus-5');
    expect(record.runs.a.id).not.toBe(record.runs.b.id);
    expect(record.task.title).toBe('Fix the flaky test');
    expect(record.environment.os.platform).toBe('other');
    expect(record.verdict).toBeNull();
  });

  it('resolves an issue task into a prompt that names the issue', () => {
    const built = specFromForm(
      form({
        taskKind: 'issue',
        issueRepo: 'owner/repo',
        issueNumber: '1234',
        issueInstructions: 'Keep the public API unchanged.',
        repositorySource: 'https://github.com/owner/repo',
        agentA: 'fake',
        harnessA: 'vanilla',
        agentB: 'fake',
        harnessB: './local-harness',
      }),
    );
    if (!built.ok) throw new Error(built.errors.join('; '));

    const record = buildPendingRecord(built.spec);
    expect(record.task.source).toEqual({
      kind: 'issue',
      repo: 'owner/repo',
      number: 1234,
      url: 'https://github.com/owner/repo/issues/1234',
    });
    expect(record.task.prompt).toContain('https://github.com/owner/repo/issues/1234');
    expect(record.task.prompt).toContain('Keep the public API unchanged.');
    // a local harness path belongs to the machine that will run the battle: it is never resolved here
    expect(record.runs.b.harness.source).toBe('./local-harness');
    expect(record.runs.b.harness.kind).toBe('local');
    expect(record.runs.b.harness.name).toBe('local-harness');
  });

  it('reports field-level errors instead of throwing', () => {
    const missingPrompt = specFromForm(form({ taskKind: 'prompt', prompt: '' }));
    expect(missingPrompt.ok).toBe(false);
    if (missingPrompt.ok) throw new Error('expected a failure');
    expect(missingPrompt.errors.join(' ')).toContain('task');

    const badAssertions = specFromForm(form({ taskKind: 'prompt', prompt: 'x', assertions: '{oops' }));
    expect(badAssertions.ok).toBe(false);
    if (badAssertions.ok) throw new Error('expected a failure');
    expect(badAssertions.errors[0]).toContain('not valid JSON');

    const missingIssueNumber = specFromForm(form({ taskKind: 'issue', issueRepo: 'owner/repo' }));
    expect(missingIssueNumber.ok).toBe(false);
    if (missingIssueNumber.ok) throw new Error('expected a failure');
    expect(missingIssueNumber.errors).toContain('An issue number is required.');

    const badAgent = specFromForm(
      form({ taskKind: 'prompt', prompt: 'x', agentA: 'NotAnAgentId', harnessA: 'vanilla' }),
    );
    expect(badAgent.ok).toBe(false);
  });
});
