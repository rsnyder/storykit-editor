const destination = new URL('https://storykit-editor.ron-f9a.workers.dev/editor/');
// Preserve the old bookmarklet contract without forwarding unrelated parameters.
const source = new URL(location.href);
for (const name of ['open', 'repo', 'branch']) if (source.searchParams.has(name)) destination.searchParams.set(name, source.searchParams.get(name));
document.getElementById('open-editor').href = destination.href;
