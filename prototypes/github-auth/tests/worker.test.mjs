import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, sha } from './support.mjs';
import { hash, seal, unseal } from '../src/worker.js';

const destination = { owner: 'demo-author', repo: 'field-notes', branch: 'main', path: '_posts/new.md', content: '# New story — café 🌱', expectedSha: null };
async function signedIn() { const h = harness(); const { session } = await h.login(); h.csrf = session.csrf; return h; }
const save = (h, data = destination) => h.request('/api/github/save', { method: 'POST', headers: { 'X-CSRF-Token': h.csrf }, body: data });

test('unconfigured service leaves static authoring and session discovery available', async () => {
  const h = harness(); h.env.GITHUB_CLIENT_SECRET = '';
  assert.equal((await h.request('/')).status, 200);
  assert.equal((await (await h.request('/api/session')).json()).configured, false);
  assert.equal((await h.request('/api/auth/start', { method: 'POST', body: {} })).status, 503);
});
test('OAuth uses PKCE, fixed callback, browser binding, and secure host-only cookie', async () => {
  const h = harness(); const response = await h.request('/api/auth/start', { method: 'POST', body: {} });
  const url = new URL((await response.json()).url);
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.searchParams.get('redirect_uri'), `${h.env.APP_ORIGIN}/api/auth/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const row = h.env.DB.sqlite.prepare('SELECT * FROM oauth_states').get();
  assert.equal(await hash(await unseal(row.verifier, h.env)), url.searchParams.get('code_challenge'));
  assert.match(response.headers.get('Set-Cookie'), /^__Host-sk_oauth=.*HttpOnly; SameSite=Lax;.*Secure$/);
  assert.notEqual(row.state_hash, url.searchParams.get('state'));
});
test('callback requires initiating browser and consumes state only once', async () => {
  const h = harness();
  const start = new URL((await (await h.request('/api/auth/start', { method:'POST', body:{} })).json()).url);
  const path = `/api/auth/callback?state=${start.searchParams.get('state')}&code=demo`;
  const copiedJar = new Map(h.jar);
  assert.equal((await h.request(path, { cookies: false })).headers.get('Location'), '/?auth=invalid');
  h.jar.clear(); for (const pair of copiedJar) h.jar.set(...pair);
  assert.equal((await h.request(path)).headers.get('Location'), '/?auth=success');
  for (const pair of copiedJar) h.jar.set(...pair);
  assert.equal((await h.request(path)).headers.get('Location'), '/?auth=invalid');
  assert.equal(h.upstream.calls.filter(c => c.url.endsWith('/access_token')).length, 1);
});
test('cancelled, failed, and expired login do not create sessions', async () => {
  for (const outcome of ['cancelled', 'failed', 'invalid']) {
    const h = harness();
    const url = new URL((await (await h.request('/api/auth/start', { method: 'POST', body: {} })).json()).url);
    if (outcome === 'invalid') h.env.DB.sqlite.exec('UPDATE oauth_states SET expires_at = 0');
    const query = outcome === 'cancelled' ? 'error=access_denied' : 'code=rejected';
    const response = await h.request(`/api/auth/callback?state=${url.searchParams.get('state')}&${query}`);
    assert.equal(response.headers.get('Location'), outcome === 'failed' ? '/?auth=failed&reason=bad_verification_code' : `/?auth=${outcome}`);
    assert.equal(h.env.DB.sqlite.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  }
});
test('OAuth rejects upstream redirects without following them or leaking their destination', async () => {
  let calls = 0;
  const h = harness(undefined, async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    assert.equal(url, 'https://github.com/login/oauth/access_token');
    return new Response(null, { status: 302, headers: { Location: 'https://unexpected.example/secret-destination' } });
  });
  const { callback, session } = await h.login();
  assert.equal(callback.headers.get('Location'), '/?auth=failed&reason=network_redirect');
  assert.equal(session.user, null);
  assert.equal(calls, 1);
});
test('session exposes identity and CSRF, not GitHub credentials; tokens encrypted at rest', async () => {
  const h = await signedIn(), session = await (await h.request('/api/session')).json();
  assert.equal(session.user.login, 'demo-author');
  const row = h.env.DB.sqlite.prepare('SELECT * FROM sessions').get();
  assert(!JSON.stringify(row).includes('fake-token-'));
  assert(!JSON.stringify(session).includes('fake-token-'));
  assert.match(await unseal(row.token, h.env), /^fake-token-/);
  assert.notEqual(row.id_hash, h.jar.get('__Host-sk_session'));
});
test('AES-GCM ciphertext rejects tampering', async () => {
  const h = harness(), value = await seal('credential', h.env);
  const [iv, data] = value.split('.');
  const bytes = Buffer.from(data, 'base64'); bytes[0] ^= 1;
  await assert.rejects(unseal(`${iv}.${bytes.toString('base64')}`, h.env));
});
test('login rotates old session and account identity; logout invalidates it', async () => {
  const h = await signedIn(), old = h.jar.get('__Host-sk_session');
  const { session } = await h.login('other');
  assert.equal(session.user.login, 'other-author');
  assert.notEqual(h.jar.get('__Host-sk_session'), old);
  assert.equal(h.env.DB.sqlite.prepare('SELECT count(*) n FROM sessions').get().n, 1);
  const out = await h.request('/api/auth/logout', { method: 'POST', body: {}, headers: { 'X-CSRF-Token': session.csrf } });
  assert.equal(out.status, 200); assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await h.request('/api/github/repos')).status, 401);
});
test('write endpoints reject cross-origin requests and missing CSRF before any writes', async () => {
  const h = await signedIn();
  const badOrigin = await h.request('/api/github/save', { method:'POST', body:destination, headers: { Origin: 'https://other.example', 'X-CSRF-Token': h.csrf } });
  assert.equal(badOrigin.status, 403);
  assert.equal((await h.request('/api/github/save', { method:'POST', body:destination })).status, 403);
  assert.equal(h.upstream.writes.length, 0);
});
test('repository pagination includes collaborator repositories and filters read-only/archived', async () => {
  const h = await signedIn();
  for (let n = 5; n < 109; n++) h.upstream.repos.push({ ...h.upstream.repos[0], id: n, name: `repo-${n}`, full_name: `demo-author/repo-${n}` });
  const first = await (await h.request('/api/github/repos')).json();
  const second = await (await h.request('/api/github/repos?page=2')).json();
  assert.equal(first.nextPage, 2); assert.equal(second.nextPage, null);
  const items = [...first.items, ...second.items];
  assert.equal(items.length, 106); assert(items.some(r => r.fullName === 'community/shared-stories'));
  assert(!items.some(r => r.name === 'archive' || r.name === 'old-stories'));
});
test('public-only scope excludes private repositories from picker', async () => {
  const h = await signedIn(); h.env.GITHUB_SCOPE = 'public_repo';
  const data = await (await h.request('/api/github/repos')).json();
  assert(data.items.every(r => !r.private));
});
test('branches paginate and preserve slash-containing names', async () => {
  const h = await signedIn();
  h.upstream.branches.set(1, [...h.upstream.branches.get(1), ...Array.from({length:101}, (_,n)=>`drafts/${n}`)]);
  const first = await (await h.request('/api/github/branches?owner=demo-author&repo=field-notes')).json();
  const second = await (await h.request('/api/github/branches?owner=demo-author&repo=field-notes&page=2')).json();
  assert.equal(first.nextPage,2); assert.equal(second.items.length,4);
  assert(first.items.some(b => b.name === 'drafts/field-trip'));
});
test('review is read-only and distinguishes new and existing files', async () => {
  const h = await signedIn();
  const existing = await (await h.request('/api/github/file?owner=demo-author&repo=field-notes&branch=main&path=_posts/existing.md')).json();
  const missing = await (await h.request('/api/github/file?owner=demo-author&repo=field-notes&branch=main&path=_posts/new.md')).json();
  assert.match(existing.file.content, /Someone else/); assert.equal(missing.file,null);
  assert.equal(h.upstream.writes.length,0);
});
test('save creates a UTF-8 file with an explicit null SHA', async () => {
  const h = await signedIn(), response = await save(h);
  assert.equal(response.status,200); assert.equal((await response.json()).sha,sha(destination.content));
  assert.equal(h.upstream.writes[0].content,destination.content);
});
test('existing file requires reviewed SHA and refuses a stale review', async () => {
  const h = await signedIn(), file = h.upstream.files.get('demo-author/field-notes/main/_posts/existing.md');
  assert.equal((await save(h,{...destination,path:'_posts/existing.md'})).status,409);
  const oldSha = file.sha;
  h.upstream.setFile('demo-author','field-notes','main','_posts/existing.md','remote changed');
  assert.equal((await save(h,{...destination,path:'_posts/existing.md',expectedSha:oldSha})).status,409);
  assert.equal(h.upstream.writes.length,0);
  assert.equal((await save(h,{...destination,path:'_posts/existing.md',expectedSha:sha('remote changed')})).status,200);
});
test('new branch is created only on save and supports slash names', async () => {
  const h = await signedIn();
  const response = await save(h,{...destination,branch:'drafts/new-story',createBranch:true});
  assert.equal(response.status,200);
  assert.deepEqual(h.upstream.writes.map(w=>w.method),['POST','PUT']);
  assert(h.upstream.branches.get(1).includes('drafts/new-story'));
});
test('unchanged content avoids an unnecessary commit', async () => {
  const h = await signedIn(); await save(h);
  const response = await save(h,{...destination,expectedSha:sha(destination.content)});
  assert.equal((await response.json()).unchanged,true); assert.equal(h.upstream.writes.length,1);
});
test('repository access is rechecked at write time', async () => {
  const h = await signedIn(); h.upstream.repos[0].permissions.push=false;
  assert.equal((await save(h)).status,403); assert.equal(h.upstream.writes.length,0);
});
test('protected branch refuses save and does not silently change the destination', async () => {
  const h = await signedIn();
  const response = await save(h,{...destination,branch:'protected'});
  assert.equal(response.status,403); assert.equal(h.upstream.writes.length,0);
});
test('uncertain write failure is not automatically retried', async () => {
  const h = await signedIn(); h.upstream.failNextSave=true;
  const response = await save(h);
  assert.equal(response.status,502); assert.equal((await response.json()).error.code,'network');
  assert.equal(h.upstream.calls.filter(c=>c.method==='PUT').length,1);
  assert.equal(h.env.DB.sqlite.prepare('SELECT count(*) n FROM write_locks').get().n,0);
});
test('write lease prevents overlapping saves across requests', async () => {
  const h = await signedIn();
  h.env.DB.sqlite.prepare('INSERT INTO write_locks VALUES (?, ?, ?)').run('101/demo-author/field-notes/main','another-request',Math.floor(Date.now()/1000)+90);
  const response = await save(h);
  assert.equal(response.status,409); assert.equal((await response.json()).error.code,'busy'); assert.equal(h.upstream.writes.length,0);
});
test('file paths and branch input cannot escape constrained GitHub routes', async () => {
  const h = await signedIn();
  for (const path of ['../secret.md','.github/workflows/run.md','/absolute.md','a//b.md','a\\b.md','file.html']) assert.equal((await save(h,{...destination,path})).status,400);
  for (const branch of ['bad..branch','a.lock','/main','a@{b','a b','a//b']) assert.equal((await save(h,{...destination,branch})).status,400);
  assert.equal((await save(h,{...destination,owner:'x/../../user'})).status,400);
  assert.equal(h.upstream.writes.length,0);
});
test('oversize drafts are rejected before GitHub writes', async () => {
  const h=await signedIn(); assert.equal((await save(h,{...destination,content:'x'.repeat(200001)})).status,413);
  assert.equal(h.upstream.writes.length,0);
});
test('expired or revoked tokens require sign-in and never silently refresh a write', async () => {
  const h=await signedIn(); h.upstream.tokens.clear();
  assert.equal((await h.request('/api/github/repos')).status,401);
  assert.equal((await (await h.request('/api/session')).json()).user,null);
  await h.login(); h.env.DB.sqlite.exec('UPDATE sessions SET expires_at = 0');
  assert.equal((await save(h)).status,401);
});
test('static and API responses prohibit framing and cache storage; unknown APIs never serve HTML', async () => {
  const h=await signedIn();
  for (const path of ['/','/api/session']) {
    const response=await h.request(path);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
    assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
  }
  assert.equal((await h.request('/api/not-real')).status,404);
});
test('only the public image and map viewers can be framed and its modules allow opaque preview origins', async () => {
  const h = harness();
  const viewer = await h.request('/assets/components/image.html');
  assert.equal(viewer.headers.get('X-Frame-Options'), null);
  const policy = viewer.headers.get('Content-Security-Policy');
  assert.match(policy, /sandbox allow-scripts/);
  assert.match(policy, /https?:\/\/[^ ;]+\/assets\/js\//);
  assert.ok(!policy.includes('allow-same-origin'));
  assert.equal((await h.request('/assets/components/image')).headers.get('X-Frame-Options'), null);
  assert.equal((await h.request('/assets/js/storykit-local-image.js')).headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await h.request('/assets/components/map.html')).headers.get('X-Frame-Options'), null);
  assert.equal((await h.request('/assets/components/map')).headers.get('X-Frame-Options'), null);
  assert.equal((await h.request('/assets/components/iframe.html')).headers.get('X-Frame-Options'), 'DENY');
  const api = await h.request('/api/session');
  assert.equal(api.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(api.headers.get('X-Frame-Options'), 'DENY');
});
test('scheduled cleanup removes expired rows only', async () => {
  const h=await signedIn();
  h.env.DB.sqlite.exec("INSERT INTO oauth_states (state_hash,browser_hash,verifier,expires_at) VALUES ('expired','browser','cipher',0); INSERT INTO write_locks VALUES ('expired','nonce',0)");
  await h.worker.scheduled({},h.env);
  assert.equal(h.env.DB.sqlite.prepare('SELECT count(*) n FROM oauth_states').get().n,0);
  assert.equal(h.env.DB.sqlite.prepare('SELECT count(*) n FROM write_locks').get().n,0);
  assert.equal(h.env.DB.sqlite.prepare('SELECT count(*) n FROM sessions').get().n,1);
});


test('editor OAuth returns only to the allowlisted editor path', async () => {
  for (const [returnTo, expected] of [['/editor/', '/editor/'], ['https://evil.example/', '/']]) {
    const h = harness();
    const start = new URL((await (await h.request('/api/auth/start', { method: 'POST', body: { returnTo } })).json()).url);
    const response = await h.request(`/api/auth/callback?state=${start.searchParams.get('state')}&code=demo`);
    assert.equal(response.headers.get('Location'), `${expected}?auth=success`);
  }
});
test('editor can read accessible read-only repos, but cannot write or create branches there', async () => {
  const h = await signedIn();
  h.upstream.setFile('museum', 'archive', 'main', 'notes.md', '# Public notes');
  const file = await (await h.request('/api/github/read?owner=museum&repo=archive&branch=main&path=notes.md')).json();
  assert.equal(file.file.content, '# Public notes');
  const response = await h.request('/api/github/create-branch', { method: 'POST', headers: { 'X-CSRF-Token': h.csrf }, body: { owner: 'museum', repo: 'archive', branch: 'new', fromSha: 'a'.repeat(40) } });
  assert.equal(response.status, 403);
  assert.equal(h.upstream.writes.length, 0);
});
