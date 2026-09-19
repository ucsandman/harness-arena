import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/brand';

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Reserved for later waves: account surfaces and the ingestion API are never indexable.
        disallow: ['/api/', '/login', '/dashboard', '/device'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
