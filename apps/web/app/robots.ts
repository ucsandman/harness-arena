import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/brand';

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // account surfaces, the device flow, the ingestion API and every authoring form are never
        // indexable; the objects those forms create are, so only the /new paths are listed
        disallow: [
          '/api/',
          '/login',
          '/dashboard',
          '/settings',
          '/device',
          '/battles/new',
          '/challenges/new',
          '/tournaments/new',
          '/bounties/new',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
