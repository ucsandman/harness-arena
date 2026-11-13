import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
export function generateDocs() {
  const source = path.resolve(appRoot, '../../docs');
  const output = path.join(appRoot, 'lib/generated/docs.json');
  const docs = Object.fromEntries(
    readdirSync(source)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => [`docs/${name}`, readFileSync(path.join(source, name), 'utf8')]),
  );
  const content = JSON.stringify(docs);
  mkdirSync(path.dirname(output), { recursive: true });
  let previous = null;
  try {
    previous = readFileSync(output, 'utf8');
  } catch {
    /* First build. */
  }
  if (previous !== content) writeFileSync(output, content);
  return docs;
}
