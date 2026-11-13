import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// Check the deployment artifact, not just a development checkout where every doc exists.
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(appRoot, '../..');
const required = [
  path.join(repoRoot, 'pnpm-workspace.yaml'),
  ...readdirSync(path.join(repoRoot, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(repoRoot, 'docs', name)),
];
const routes = ['docs/[[...slug]]/page', 'privacy/page', 'security/page', 'sitemap.xml/route'];
for (const route of routes) {
  const manifest = path.join(appRoot, '.next/server/app', `${route}.js.nft.json`);
  const { files } = JSON.parse(readFileSync(manifest, 'utf8'));
  const traced = new Set(files.map((file) => path.resolve(path.dirname(manifest), file)));
  const missing = required.filter((file) => !traced.has(file));
  if (missing.length > 0) {
    throw new Error(
      `Missing serverless documentation assets for ${route}: ${missing.map((file) => path.relative(repoRoot, file)).join(', ')}`,
    );
  }
}
console.log(`Verified ${required.length} documentation assets in ${routes.length} serverless traces.`);
