import { AGENT_CATALOG, listBenchmarks, listHarnesses, type ArenaDatabase } from '@harness-arena/database';
import type { AgentOption, BenchmarkOption, HarnessOption } from '@/components/arena/form-fields';

/**
 * The pickers the three competitive forms share, read on the server and handed down as plain data.
 *
 * Kept out of lib/arena-forms.ts on purpose: that module is imported by client components, and this
 * one imports the database package.
 */

export interface ArenaFormOptions {
  harnesses: HarnessOption[];
  benchmarks: BenchmarkOption[];
  agents: AgentOption[];
}

/** The agent CLIs Arena drives, from the catalogue the battle pipeline itself uses. */
export function agentOptions(): AgentOption[] {
  return Object.entries(AGENT_CATALOG).map(([id, entry]) => ({
    id,
    label: entry.displayName,
    vendor: entry.vendor,
  }));
}

export async function arenaFormOptions(
  db: ArenaDatabase,
  viewerUserId: string | null,
): Promise<ArenaFormOptions> {
  const [harnesses, packs] = await Promise.all([
    listHarnesses(db, { limit: 200 }),
    listBenchmarks(db, { limit: 100, viewerUserId }),
  ]);

  return {
    // only harnesses with a resolvable URL: a local path on somebody else's machine is not a
    // reference anyone else can run, so offering it in a picker would be a broken control
    harnesses: harnesses
      .filter((harness): harness is typeof harness & { sourceUrl: string } => Boolean(harness.sourceUrl))
      .map((harness) => ({ slug: harness.slug, name: harness.name, source: harness.sourceUrl })),
    benchmarks: packs.map((pack) => ({
      slug: pack.slug,
      name: pack.name,
      version: pack.version,
      versionId: pack.versionId,
      taskCount: pack.taskCount,
      battlesPerRun: pack.battlesPerRun,
    })),
    agents: agentOptions(),
  };
}

/** `?a=<slug>` and `?b=<slug>` prefills: a known slug becomes its source, anything else stays blank. */
export function sourceForSlug(harnesses: readonly HarnessOption[], slug: string | undefined): string {
  if (!slug) return '';
  if (slug === 'vanilla') return 'vanilla';
  return harnesses.find((harness) => harness.slug === slug)?.source ?? '';
}
