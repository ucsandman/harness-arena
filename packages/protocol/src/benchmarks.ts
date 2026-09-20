import { z } from 'zod';
import { ratingCategorySchema } from './ratings.js';
import {
  evaluationSpecSchema,
  limitsSchema,
  repositorySpecSchema,
  taskSpecSchema,
  visibilitySchema,
} from './battle.js';

/**
 * Benchmark packs
 * ---------------
 * A pack is a reusable, versioned collection of battle tasks. Ranked results are pinned to a pack
 * VERSION, and a version is identified by the sha256 of its canonical content, so a historical result
 * can never point at a definition that later changed: editing a task yields a new version id.
 */

export const BENCHMARK_PACK_VERSION = 1 as const;

export const benchmarkTaskIdSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'task id must be lowercase; letters, digits, dot, dash, underscore');

export const benchmarkTaskSchema = z.object({
  /** stable within the pack, e.g. `fix-null-deref` */
  id: benchmarkTaskIdSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** the rating category this task counts towards; `overall` is implied for every task */
  category: ratingCategorySchema,
  /** free-form labels (language, framework, difficulty) */
  tags: z.array(z.string().max(40)).max(20).default([]),
  task: taskSpecSchema,
  /** a ranked run requires `commit`; a pack may ship with a ref and be pinned on first resolution */
  repository: repositorySpecSchema,
  evaluation: evaluationSpecSchema.prefault({}),
  limits: limitsSchema.prefault({}),
  /** repeated runs per side; the experiment and benchmark commands use it for sample size */
  trials: z.number().int().min(1).max(20).default(1),
});
export type BenchmarkTask = z.infer<typeof benchmarkTaskSchema>;
export type BenchmarkTaskInput = z.input<typeof benchmarkTaskSchema>;

export const benchmarkSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, digits and dashes');

export const benchmarkPackSchema = z
  .object({
    benchmark: z.literal(BENCHMARK_PACK_VERSION),
    slug: benchmarkSlugSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    /** GitHub login or free text; the server records the uploading user separately */
    author: z.string().max(120).optional(),
    /** human version label; the immutable identity is the content hash, not this string */
    version: z.string().min(1).max(40),
    homepage: z.url().optional(),
    license: z.string().max(60).optional(),
    visibility: visibilitySchema.default('public'),
    tasks: z.array(benchmarkTaskSchema).min(1).max(200),
  })
  .superRefine((pack, ctx) => {
    const seen = new Set<string>();
    pack.tasks.forEach((task, index) => {
      if (seen.has(task.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', index, 'id'],
          message: `duplicate task id ${task.id}`,
        });
      }
      seen.add(task.id);
    });
  });
export type BenchmarkPack = z.infer<typeof benchmarkPackSchema>;
export type BenchmarkPackInput = z.input<typeof benchmarkPackSchema>;

/** The categories a pack covers, in first-seen order, `overall` excluded. */
export function benchmarkCategories(pack: Pick<BenchmarkPack, 'tasks'>): string[] {
  const out: string[] = [];
  for (const task of pack.tasks) {
    if (task.category !== 'overall' && !out.includes(task.category)) out.push(task.category);
  }
  return out;
}

/**
 * Stable JSON: keys sorted at every level, no whitespace. Two packs with the same content produce the
 * same string regardless of key order in the source file.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export { battleBenchmarkRefSchema } from './battle.js';
export type { BattleBenchmarkRef } from './battle.js';

/** `bmv_` + the first 24 hex chars of sha256(canonical pack JSON). Async because it uses Web Crypto. */
export async function benchmarkVersionId(pack: BenchmarkPack): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(pack));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `bmv_${hex.slice(0, 24)}`;
}

/** A pack version as the API returns it: the immutable content plus catalogue metadata. */
export const benchmarkVersionSummarySchema = z.object({
  versionId: z.string(),
  slug: benchmarkSlugSchema,
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  categories: z.array(z.string()),
  taskCount: z.number().int().nonnegative(),
  /** sum of trials over tasks: the number of battles one full run produces */
  battlesPerRun: z.number().int().nonnegative(),
  visibility: visibilitySchema,
  createdAt: z.string(),
});
export type BenchmarkVersionSummary = z.infer<typeof benchmarkVersionSummarySchema>;
