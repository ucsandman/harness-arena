import { z } from 'zod';

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
