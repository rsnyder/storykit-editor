import { describe, it, assert } from './runner.js';
import * as github from '../../editor/github.js';
import * as auth from '../../editor/auth.js';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function stub(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); }
  finally { globalThis.fetch = async () => json({ user: null }); await auth.refresh(); globalThis.fetch = original; }
}
describe('GitHub session adapter', () => {
  it('reads public files without sending a legacy PAT', async () => {
    localStorage.setItem('jekyllPreviewPAT', 'legacy-test-token');
    try {
      await stub(async (url, options) => {
        assert.ok(url.startsWith('https://api.github.com/'));
        assert.ok(!options.headers.Authorization);
        return json({ encoding: 'base64', content: btoa('hello'), sha: 'abc' });
      }, async () => assert.equal((await github.getFile({ owner: 'o', repo: 'r', ref: 'main', path: 'a b.md' })).content, 'hello'));
    } finally { localStorage.removeItem('jekyllPreviewPAT'); }
  });
  it('uses the same-origin read endpoint after login', async () => {
    await stub(async url => url === '/api/session' ? json({ user: { id: 1 }, csrf: 'csrf' }) : (assert.ok(url.startsWith('/api/github/read?')), json({ file: { content: 'private', sha: 'abc' } })), async () => {
      await auth.refresh(); assert.equal((await github.getFile({ owner: 'o', repo: 'r', ref: 'drafts/one', path: 'a.md' })).content, 'private');
    });
  });
  it('sends the original SHA and CSRF to the constrained save endpoint', async () => {
    await stub(async (url, options) => {
      if (url === '/api/session') return json({ user: { id: 1 }, csrf: 'csrf' });
      assert.equal(url, '/api/github/save'); assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-CSRF-Token'], 'csrf');
      const body = JSON.parse(options.body); assert.equal(body.expectedSha, 'original'); assert.equal(body.content, 'café');
      return json({ sha: 'next' });
    }, async () => { await auth.refresh(); assert.equal((await github.putFile({ owner: 'o', repo: 'r', branch: 'main', path: 'a.md', content: 'café', sha: 'original' })).sha, 'next'); });
  });
  it('maps session expiry and conflicts for the existing sync flow', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [409, 'conflict'], [422, 'conflict'], [429, 'rate-limit']]) {
      await stub(async () => json({ error: { message: 'Denied' } }, status), async () => {
        let caught; try { await github.putFile({}); } catch (e) { caught = e; }
        assert.equal(caught.kind, kind);
      });
    }
  });
  it('loads all repository and branch pages', async () => {
    await stub(async url => json({ items: [{ name: url.endsWith('page=2') ? 'second' : 'first' }], nextPage: url.endsWith('page=2') ? null : 2 }), async () => {
      assert.equal((await github.listRepositories()).length, 2);
      assert.equal((await github.listBranches({ owner: 'o', repo: 'r' })).length, 2);
    });
  });
  it('retains public 404 and 304 read semantics', async () => {
    for (const [status, expected] of [[404, null], [304, 'not-modified']]) await stub(async () => new Response(null, { status }), async () => {
      assert.equal(await github.getFile({ owner: 'o', repo: 'r', ref: 'main', path: 'a.md' }), expected);
    });
  });
});
