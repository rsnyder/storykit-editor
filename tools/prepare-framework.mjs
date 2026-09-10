/** Materialize the versioned starter dependency for builds and integration tests. */
import { cp, readdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const fixture = new URL('../tests/fixtures/starter/', import.meta.url);
for (const entry of await readdir(fixture)) {
  if (entry === 'SOURCE.json') continue;
  await cp(new URL(entry, fixture), new URL(entry, root), { recursive: true });
}
console.log('Prepared pinned starter framework fixture.');
