import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/brand';

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // account surfaces, the device flow and the ingestion API are never indexable
        disallow: ['/api/', '/login', '/dashboard', '/settings', '/device', '/battles/new'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
