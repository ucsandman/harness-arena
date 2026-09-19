import type { MetadataRoute } from 'next';
import { listBattles, listHarnesses } from '@harness-arena/database';
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
  '/privacy',
  '/security',
] as const;

/** Public battles and harnesses only. Private and unlisted battles never enter the sitemap. */
async function dynamicRoutes(): Promise<Array<{ route: string; lastModified: Date }>> {
  try {
    const dbh = await db();
    const [feed, harnesses] = await Promise.all([
      listBattles(dbh, { limit: 200, visibility: 'public' }),
      listHarnesses(dbh, { limit: 200 }),
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
