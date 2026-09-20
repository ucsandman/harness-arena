import type { MetadataRoute } from 'next';
import {
  listBattles,
  listBenchmarks,
  listBounties,
  listChallenges,
  listComponents,
  listExperiments,
  listHarnesses,
  listTournaments,
} from '@harness-arena/database';
import { siteUrl } from '@/lib/brand';
import { db } from '@/lib/db';
import { DOC_PAGES, docHref } from '@/lib/docs';

// battle and harness entries are read per request; a stale sitemap is worse than a dynamic one
export const dynamic = 'force-dynamic';

const STATIC_ROUTES = [
  '/',
  '/battles',
  '/harnesses',
  '/harnesses/import',
  '/leaderboard',
  '/explore',
  '/benchmarks',
  '/challenges',
  '/experiments',
  '/tournaments',
  '/bounties',
  '/components',
  '/privacy',
  '/security',
] as const;

/**
 * Public records only. Private and unlisted battles never enter the sitemap, `listChallenges` and
 * `listTournaments` are public-only by construction, and the experiment read passes no viewer so a
 * private experiment cannot appear.
 */
async function dynamicRoutes(): Promise<Array<{ route: string; lastModified: Date }>> {
  try {
    const dbh = await db();
    const [feed, harnesses, packs, challenges, experiments, tournaments, bounties, components] =
      await Promise.all([
        listBattles(dbh, { limit: 200, visibility: 'public' }),
        listHarnesses(dbh, { limit: 200 }),
        listBenchmarks(dbh, { limit: 100, viewerUserId: null }),
        listChallenges(dbh, { limit: 100 }),
        listExperiments(dbh, { limit: 100, viewerUserId: null }),
        listTournaments(dbh, { limit: 100 }),
        listBounties(dbh, { limit: 100 }),
        listComponents(dbh, { limit: 200 }),
      ]);
    return [
      ...feed.items.map((battle) => ({
        route: `/battles/${battle.id}`,
        lastModified: new Date(battle.completedAt ?? battle.createdAt),
      })),
      ...harnesses.map((harness) => ({
        route: `/harnesses/${harness.slug}`,
        lastModified: harness.updatedAt,
      })),
      ...packs.map((pack) => ({
        route: `/benchmarks/${pack.slug}`,
        lastModified: new Date(pack.createdAt),
      })),
      ...challenges.map((challenge) => ({
        route: `/challenges/${challenge.id}`,
        lastModified: new Date(challenge.completedAt ?? challenge.createdAt),
      })),
      ...experiments
        .filter((experiment) => experiment.visibility === 'public')
        .map((experiment) => ({
          route: `/experiments/${experiment.id}`,
          lastModified: new Date(experiment.completedAt ?? experiment.createdAt),
        })),
      ...tournaments.map((tournament) => ({
        route: `/tournaments/${tournament.slug}`,
        lastModified: new Date(tournament.createdAt),
      })),
      ...bounties.map((bounty) => ({
        route: `/bounties/${bounty.id}`,
        lastModified: new Date(bounty.createdAt),
      })),
      ...components.map((component) => ({
        route: `/components/${component.slug}`,
        lastModified: new Date(component.createdAt),
      })),
    ];
  } catch {
    // no database available (a build without one): the static routes are still a valid sitemap
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const now = new Date();
  const staticEntries = [...STATIC_ROUTES, ...DOC_PAGES.map(docHref)].map((route) => ({
    route,
    lastModified: now,
  }));
  const entries = [...staticEntries, ...(await dynamicRoutes())];

  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.route)) return false;
    seen.add(entry.route);
    return true;
  });

  return unique.map((entry) => ({
    url: `${base}${entry.route === '/' ? '' : entry.route}`,
    lastModified: entry.lastModified,
    changeFrequency: entry.route === '/' || entry.route === '/battles' ? 'daily' : 'weekly',
    priority: entry.route === '/' ? 1 : entry.route.startsWith('/battles/') ? 0.5 : 0.6,
  }));
}
