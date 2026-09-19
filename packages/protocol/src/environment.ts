import { z } from 'zod';

/**
 * Reproducibility metadata recorded with every battle. Deliberately excludes hostname, username,
 * home directory and environment variable values.
 */
export const environmentInfoSchema = z.object({
  os: z.object({
    platform: z.enum(['win32', 'darwin', 'linux', 'other']),
    release: z.string(),
    arch: z.string(),
  }),
  node: z.string(),
  git: z.string().nullable(),
  arenaVersion: z.string(),
  ci: z.boolean(),
  cpuCount: z.number().int().nonnegative(),
  memoryGb: z.number().nonnegative(),
  /** agent id -> version/path as detected at battle time */
  agents: z.record(
    z.string(),
    z.object({
      version: z.string().nullable(),
      /** true when the CLI was told to ignore user-level config, so only the harness differs */
      userConfigIsolated: z.boolean().nullable(),
    }),
  ),
  /** what Arena itself contributed to both sides (e.g. shared CLI flags) */
  sharedFlags: z.record(z.string(), z.array(z.string())).default({}),
  recordedAt: z.string(),
});
export type EnvironmentInfo = z.infer<typeof environmentInfoSchema>;
