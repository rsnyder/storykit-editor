import '../../../tools/prepare-framework.mjs';
/** Copy only public application assets; never publish the repository root. */
import { cp, mkdir, rm } from 'node:fs/promises';
const root = new URL('../../../', import.meta.url);
const output = new URL('../.editor-assets/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('../public/', import.meta.url), output, { recursive: true });
for (const path of ['editor', 'assets/js', 'assets/components', 'assets/css', 'assets/img']) {
  await cp(new URL(path, root), new URL(path, output), { recursive: true });
}
// Public Liquid templates required to preview a story before its repository
// has installed StoryKit. Keep this allowlist separate from repository data.
for (const path of ['_includes/embed', '_includes/media-url.html']) {
  const target = new URL('editor/framework/' + path, output);
  await mkdir(new URL('./', target), { recursive: true });
  await cp(new URL(path, root), target, { recursive: true });
}
console.log('Built editor staging assets.');
