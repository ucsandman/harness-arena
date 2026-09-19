import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/brand';
import { DOC_PAGES, docHref } from '@/lib/docs';

/** Static routes only. Battle and harness pages join the sitemap when those pages ship. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const lastModified = new Date();
  const routes = ['/', '/privacy', '/security', ...DOC_PAGES.map(docHref)];
  const unique = Array.from(new Set(routes));
  return unique.map((route) => ({
    url: `${base}${route === '/' ? '' : route}`,
    lastModified,
    changeFrequency: route === '/' ? 'weekly' : 'monthly',
    priority: route === '/' ? 1 : 0.6,
  }));
}
