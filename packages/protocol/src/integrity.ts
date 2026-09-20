import { z } from 'zod';
import type { BattleRecord, HarnessSummary, RunRecord } from './battle.js';
import { canonicalJson } from './canonical.js';
import { DEFAULT_EFFICIENCY_CONFIG } from './evaluation.js';

/**
 * Integrity
 * ---------
 * The checks that stand between a battle record and the ratings table. They are pure functions of the
 * record (plus, server-side, of what the database already holds), so a CLI can show the same verdict
 * the server will reach. A `block` flag keeps the battle out of every rating pool; a `warn` flag is
 * shown next to the result and never hidden. The server recomputes; it never trusts a client's copy.
 */

export const INTEGRITY_CODES = [
  /** deterministic demo data */
  'demo',
  /** verdict is missing or inconclusive */
  'no_decision',
  /** both sides are the same harness version on the same agent */
  'same_competitor',
  /** a github/git harness whose commit was not resolved */
  'harness_commit_missing',
  /** the task repository has no resolved commit (empty or local non-git) */
  'repository_commit_missing',
  /** the repository was dirty when the battle started */
  'repository_dirty',
  /** a side modified files under a test path */
  'tests_modified',
  /** a side deleted files under a test path */
  'tests_deleted',
  /** the same competitors already fought this exact task, commit and configuration */
  'duplicate_battle',
  /** the record was produced by a protocol version this server does not rate */
  'protocol_version',
  /** the two sides ran different agents, so the harness is not the only variable */
  'different_agents',
  /** the two sides ran different models */
  'different_models',
  /** both sides ran concurrently on one machine, so wall time is only roughly comparable */
  'parallel_execution',
  /** the battle spec did not use the default efficiency configuration */
  'custom_efficiency_config',
  /** the battle spec was private/none upload, so no evidence beyond the record exists */
  'no_uploaded_evidence',
] as const;
export const integrityCodeSchema = z.enum(INTEGRITY_CODES);
export type IntegrityCode = z.infer<typeof integrityCodeSchema>;

export const integrityFlagSchema = z.object({
  code: integrityCodeSchema,
  /** block: never rated; warn: rated, shown */
  severity: z.enum(['block', 'warn']),
  detail: z.string(),
  /** which side the flag concerns, when it concerns one */
  side: z.enum(['a', 'b']).nullable().default(null),
});
export type IntegrityFlag = z.infer<typeof integrityFlagSchema>;

export const integrityReportSchema = z.object({
  /** true when no `block` flag is present */
  eligible: z.boolean(),
  flags: z.array(integrityFlagSchema),
  /**
   * sha256 of (task id, repository commit, both agents, both harness slugs and commits, evaluation
   * spec): identical battles share it; the server uses it to detect duplicates.
   */
  fingerprint: z.string().nullable(),
  /** evaluator/arena version the checks were computed with */
  checkedWith: z.string(),
});
export type IntegrityReport = z.infer<typeof integrityReportSchema>;

/**
 * Test paths, by the same rule the evaluator's diff-signals evaluator uses. The regex is copied on
 * purpose: the protocol may not depend on the evaluator, and a rating gate that changed meaning
 * because an evaluator refactor moved a regex would rewrite history silently. Keep the two in sync;
 * `packages/evaluator/test/integrity.test.ts` asserts they agree.
 */
const TEST_PATH = /(^|\/|[._-])(tests?|specs?|__tests__)($|\/|[._-])/i;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Whether a repository-relative path belongs to a test suite. */
export function isIntegrityTestPath(filePath: string): boolean {
  return TEST_PATH.test(normalizePath(filePath));
}

function harnessIdentity(harness: HarnessSummary): { kind: string; source: string; commit: string | null } {
  return { kind: harness.kind, source: harness.source, commit: harness.commit };
}

/**
 * The canonical string behind the matchup fingerprint: everything that would have to be identical for
 * two battles to be the same experiment run twice — the task the agents read, the repository commit
 * they started from, both agents (id and model), both harnesses (kind, source, commit) and the
 * evaluation spec that judged them. Sides are kept in place: `a` and `b` are not interchangeable,
 * because a sequential battle gives the second side a warmer machine.
 *
 * Null when the repository commit is missing: without it, two battles that share this string may still
 * have run against different code, so it is not an identity.
 */
export function fingerprintInput(record: BattleRecord): string | null {
  const commit = record.repository.commit;
  if (!commit) return null;
  return canonicalJson({
    task: {
      kind: record.task.source.kind,
      title: record.task.title,
      prompt: record.task.prompt,
      source: record.task.source,
    },
    repository: { source: record.repository.source, kind: record.repository.kind, commit },
    agents: {
      a: { id: record.runs.a.agent.id, model: record.runs.a.agent.model },
      b: { id: record.runs.b.agent.id, model: record.runs.b.agent.model },
    },
    harnesses: {
      a: harnessIdentity(record.runs.a.harness),
      b: harnessIdentity(record.runs.b.harness),
    },
    evaluation: record.spec.evaluation,
  });
}

function changedTestPaths(run: RunRecord, kinds: readonly string[]): string[] {
  return run.artifacts.changedFiles
    .filter((file) => kinds.includes(file.kind) && isIntegrityTestPath(file.path))
    .map((file) => normalizePath(file.path));
}

/**
 * Every integrity check, in the order INTEGRITY_CODES declares them. Pure: the only thing the caller
 * contributes is `duplicateOf`, which needs the database. A `block` keeps the battle out of every
 * rating pool; a `warn` is shown beside the result and never hidden.
 *
 * Creating a test file is not flagged: writing a regression test for the bug is the behaviour the
 * task usually wants. Modifying one is a warning (the suite that judges the work changed under it) and
 * deleting one is a block (a deleted failing test is the cheapest way to fake a pass).
 */
export function computeIntegrityFlags(
  record: BattleRecord,
  opts: { duplicateOf?: string | null } = {},
): IntegrityFlag[] {
  const flags: IntegrityFlag[] = [];
  const add = (
    code: IntegrityCode,
    severity: 'block' | 'warn',
    detail: string,
    side: 'a' | 'b' | null = null,
  ): void => {
    flags.push({ code, severity, detail, side });
  };
  const sides = ['a', 'b'] as const;

  if (record.demo) add('demo', 'block', 'Demo data: deterministic fixtures, never rated.');

  const winner = record.verdict?.winner;
  if (!winner || winner === 'inconclusive') {
    add('no_decision', 'block', record.verdict ? 'The verdict is inconclusive.' : 'No verdict was reached.');
  }

  const a = record.runs.a;
  const b = record.runs.b;
  if (
    a.harness.source === b.harness.source &&
    a.harness.commit === b.harness.commit &&
    a.agent.id === b.agent.id
  ) {
    add(
      'same_competitor',
      'block',
      `Both sides ran ${a.harness.source} on ${a.agent.id}: there is no competitor to rate against.`,
    );
  }

  for (const side of sides) {
    const harness = record.runs[side].harness;
    if (harness.commit) continue;
    if (harness.kind === 'github' || harness.kind === 'git') {
      add(
        'harness_commit_missing',
        'block',
        `Side ${side.toUpperCase()}: ${harness.source} was not resolved to a commit, so the result cannot be attributed to a version.`,
        side,
      );
    } else if (harness.kind === 'local') {
      add(
        'harness_commit_missing',
        'warn',
        `Side ${side.toUpperCase()}: the local harness ${harness.source} is not under version control, so the exact files cannot be recovered.`,
        side,
      );
    }
  }

  if (!record.repository.commit) {
    add(
      'repository_commit_missing',
      'block',
      record.repository.kind === 'empty'
        ? 'The task started from an empty repository, so there is no commit both sides shared.'
        : 'The task repository was not resolved to a commit.',
    );
  }
  if (record.repository.dirty === true) {
    add('repository_dirty', 'warn', 'The task repository had uncommitted changes when the battle started.');
  }

  for (const side of sides) {
    const modified = changedTestPaths(record.runs[side], ['modify', 'rename']);
    if (modified.length > 0) {
      add(
        'tests_modified',
        'warn',
        `Side ${side.toUpperCase()} modified ${modified.length} test file${modified.length === 1 ? '' : 's'}: ${modified.join(', ')}.`,
        side,
      );
    }
  }
  for (const side of sides) {
    const deleted = changedTestPaths(record.runs[side], ['delete']);
    if (deleted.length > 0) {
      add(
        'tests_deleted',
        'block',
        `Side ${side.toUpperCase()} deleted ${deleted.length} test file${deleted.length === 1 ? '' : 's'}: ${deleted.join(', ')}.`,
        side,
      );
    }
  }

  if (opts.duplicateOf) {
    add('duplicate_battle', 'block', `Same matchup fingerprint as battle ${opts.duplicateOf}.`);
  }

  if ((record.protocolVersion as number) !== 1) {
    add(
      'protocol_version',
      'block',
      `Protocol version ${record.protocolVersion} is not rated by this server.`,
    );
  }

  if (a.agent.id !== b.agent.id) {
    add(
      'different_agents',
      'warn',
      `Side A ran ${a.agent.id} and side B ran ${b.agent.id}: the harness is not the only variable.`,
    );
  }
  if (a.agent.model && b.agent.model && a.agent.model !== b.agent.model) {
    add('different_models', 'warn', `Side A ran ${a.agent.model} and side B ran ${b.agent.model}.`);
  }
  if (record.spec.parallel) {
    add(
      'parallel_execution',
      'warn',
      'Both sides ran concurrently, so wall-clock time is only roughly comparable.',
    );
  }
  if (canonicalJson(record.spec.evaluation.efficiency) !== canonicalJson(DEFAULT_EFFICIENCY_CONFIG)) {
    add(
      'custom_efficiency_config',
      'warn',
      'The efficiency tie-break used weights other than the defaults; a tie may have been broken differently here than elsewhere.',
    );
  }
  if (record.spec.privacy.upload === 'none') {
    add(
      'no_uploaded_evidence',
      'warn',
      'The battle was run with upload: none, so no events or artifacts back the record up.',
    );
  }

  return flags;
}

/** A report is eligible exactly when nothing blocked it. Warnings never change eligibility. */
export function buildIntegrityReport(
  flags: IntegrityFlag[],
  fingerprint: string | null,
  checkedWith: string,
): IntegrityReport {
  return {
    eligible: !flags.some((flag) => flag.severity === 'block'),
    flags,
    fingerprint,
    checkedWith,
  };
}

export const INTEGRITY_LABELS: Record<IntegrityCode, string> = {
  demo: 'Demo data',
  no_decision: 'No decided winner',
  same_competitor: 'Same competitor on both sides',
  harness_commit_missing: 'Harness commit not pinned',
  repository_commit_missing: 'Repository commit not pinned',
  repository_dirty: 'Repository was dirty',
  tests_modified: 'Test files modified',
  tests_deleted: 'Test files deleted',
  duplicate_battle: 'Duplicate of an earlier battle',
  protocol_version: 'Unsupported protocol version',
  different_agents: 'Different agents',
  different_models: 'Different models',
  parallel_execution: 'Sides ran in parallel',
  custom_efficiency_config: 'Custom efficiency weights',
  no_uploaded_evidence: 'No uploaded evidence',
};
