/** Loopback-only fake GitHub. No demo bypass exists in the deployed Worker. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { harness } from '../tests/support.mjs';

const port = Number(process.env.PORT || 8787), origin = `http://127.0.0.1:${port}`;
const { worker, env } = harness(origin);
const allowed = new Map([['/', 'index.html'], ['/app.js', 'app.js'], ['/auth.js', 'auth.js'], ['/styles.css', 'styles.css'], ['/fonts.css', 'fonts.css']]);
env.ASSETS.fetch = async request => {
  const pathname = new URL(request.url).pathname;
  if (/^\/(editor|assets)\//.test(pathname) && !decodeURIComponent(pathname).split('/').some(p => p === '..' || p.includes('\\'))) {
    const filename = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
    try {
      return new Response(await readFile(new URL('../.editor-assets' + filename, import.meta.url)), { headers: { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/html' } });
    } catch { return new Response('Not found', { status: 404 }); }
  }
  const filename = allowed.get(pathname);
  if (!filename) return new Response('Not found', { status: 404 });
  return new Response(await readFile(new URL(`../public/${filename}`, import.meta.url)), { headers: { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' } });
};
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(400); res.end('Use the loopback address printed in the terminal.'); return; }
    const url = new URL(req.url, origin);
    if (url.pathname === '/demo/authorize') {
      const state = encodeURIComponent(url.searchParams.get('state') || '');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY' });
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated GitHub authorization</title><link rel="stylesheet" href="/styles.css"><body><div class="demo-banner">LOCAL DEMO — not GitHub</div><main><section class="card"><p class="eyebrow">SIMULATED AUTHORIZATION</p><h1>Choose a demo account</h1><p>No GitHub credentials are needed. This exercises the real callback and session code with a fake GitHub response.</p><p><a href="/api/auth/callback?state=${state}&code=demo">Continue as demo-author →</a></p><p><a href="/api/auth/callback?state=${state}&code=other">Continue as other-author →</a></p><p><a href="/api/auth/callback?state=${state}&error=access_denied">Cancel sign-in</a></p></section></main></body></html>`);
      return;
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_300_000) { res.writeHead(413); res.end('Too large'); return; }
      chunks.push(chunk);
    }
    const request = new Request(url, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    let response = await worker.fetch(request, env);
    if (url.pathname === '/api/auth/start' && response.ok) {
      const data = await response.json(), authorization = new URL(data.url);
      data.url = `${origin}/demo/authorize?state=${authorization.searchParams.get('state')}`;
      response = new Response(JSON.stringify(data), response);
    }
    if (url.pathname === '/api/session' && response.ok) {
      const data = await response.json(); data.demo = true;
      response = new Response(JSON.stringify(data), response);
    }
    const headers = Object.fromEntries(response.headers);
    if (response.headers.getSetCookie().length) headers['set-cookie'] = response.headers.getSetCookie();
    res.writeHead(response.status, headers); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Demo request failed.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`StoryKit local demo: ${origin}\nSimulated GitHub only. Drafts persist in this browser; fake repositories reset when this process stops.`));
