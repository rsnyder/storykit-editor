/** Local-only fixtures: never imported by src/worker.js or shipped as assets. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createWorker } from '../src/worker.js';

export function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_editor_return.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_workspace_operations.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async run() { return sqlite.prepare(sql).run(...values); },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}
const json = (data, status = 200, headers) => Response.json(data, { status, headers });
export const sha = value => createHash('sha1').update(value).digest('hex');
export class FakeGitHub {
  constructor() {
    this.calls = []; this.writes = []; this.files = new Map(); this.tokens = new Map(); this.failNextSave = false;
    this.repos = [
      { id: 1, owner: { login: 'demo-author' }, name: 'field-notes', full_name: 'demo-author/field-notes', private: false, default_branch: 'main', permissions: { push: true } },
      { id: 2, owner: { login: 'community' }, name: 'shared-stories', full_name: 'community/shared-stories', private: true, default_branch: 'trunk', permissions: { push: true } },
      { id: 3, owner: { login: 'museum' }, name: 'archive', full_name: 'museum/archive', private: false, default_branch: 'main', permissions: { push: false } },
      { id: 4, owner: { login: 'demo-author' }, name: 'old-stories', full_name: 'demo-author/old-stories', archived: true, permissions: { push: true } },
    ];
    this.branches = new Map([[1, ['main', 'drafts/field-trip', 'protected']], [2, ['trunk', 'drafts/collaboration']], [3, ['main']]]);
    this.setFile('demo-author', 'field-notes', 'main', '_posts/existing.md', '# Existing story\n\nSomeone else wrote this.\n');
  }
  setFile(owner, repo, branch, path, content) {
    this.files.set(`${owner}/${repo}/${branch}/${path}`, { sha: sha(content), content });
  }
  async fetch(input, options = {}) {
    const url = new URL(input);
    this.calls.push({ url: url.href, method: options.method || 'GET' });
    if (url.href === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(options.body);
      if (body.get('code') === 'rejected') return json({ error: 'bad_verification_code' });
      const token = `fake-token-${randomBytes(10).toString('hex')}`;
      this.tokens.set(token, body.get('code') === 'other' ? { id: 202, login: 'other-author' } : { id: 101, login: 'demo-author' });
      return json({ access_token: token, scope: 'repo', token_type: 'bearer', expires_in: 28800 });
    }
    if (url.origin !== 'https://api.github.com') throw new Error('Fake upstream refused unknown host');
    const token = new Headers(options.headers).get('Authorization')?.replace('Bearer ', '');
    if (!this.tokens.has(token)) return json({ message: 'Bad credentials' }, 401);
    if (url.pathname === '/user') return json(this.tokens.get(token));
    if (url.pathname === '/user/repos') {
      const page = Number(url.searchParams.get('page') || 1), start = (page - 1) * 100;
      const items = this.repos.slice(start, start + 100);
      return json(items, 200, this.repos.length > start + 100 ? { Link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` } : {});
    }
    const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/);
    if (!match) return json({ message: 'Unknown route' }, 404);
    const [, owner, repoName, tail] = match.map(decodeURIComponent);
    const repo = this.repos.find(r => r.owner.login === owner && r.name === repoName);
    if (!repo) return json({}, 404);
    if (!tail) return json(repo);
    if (tail === '/branches') {
      const page = Number(url.searchParams.get('page') || 1), all = this.branches.get(repo.id) || [], start = (page - 1) * 100;
      return json(all.slice(start, start + 100).map(name => ({ name, protected: name === 'protected' })), 200,
        all.length > start + 100 ? { Link: `<https://api.github.com${url.pathname}?page=${page + 1}>; rel="next"` } : {});
    }
    if (tail.startsWith('/branches/')) {
      const branch = tail.slice('/branches/'.length);
      return this.branches.get(repo.id)?.includes(branch) ? json({ name: branch, commit: { sha: sha(branch) } }) : json({}, 404);
    }
    if (tail === '/git/refs' && options.method === 'POST') {
      const data = JSON.parse(options.body), branch = data.ref.slice('refs/heads/'.length);
      const names = this.branches.get(repo.id) || [];
      if (names.includes(branch)) return json({}, 422);
      const source = names.find(name => sha(name) === data.sha);
      for (const [name, file] of [...this.files]) {
        const prefix = `${owner}/${repoName}/${source}/`;
        if (name.startsWith(prefix)) this.files.set(`${owner}/${repoName}/${branch}/${name.slice(prefix.length)}`, { ...file });
      }
      names.push(branch); this.branches.set(repo.id, names);
      this.writes.push({ method: 'POST', branch });
      return json({ ref: data.ref, object: { sha: data.sha } }, 201);
    }
    if (tail.startsWith('/contents/')) {
      const path = tail.slice('/contents/'.length);
      if (options.method !== 'PUT') {
        const file = this.files.get(`${owner}/${repoName}/${url.searchParams.get('ref')}/${path}`);
        return file ? json({ ...file, type: 'file', encoding: 'base64', size: Buffer.byteLength(file.content), content: Buffer.from(file.content).toString('base64') }) : json({}, 404);
      }
      const data = JSON.parse(options.body);
      if (data.branch === 'protected') return json({ message: 'Protected branch' }, 403);
      if (this.failNextSave) { this.failNextSave = false; throw new Error('Disconnected'); }
      const k = `${owner}/${repoName}/${data.branch}/${path}`, existing = this.files.get(k);
      if ((existing?.sha || undefined) !== data.sha) return json({}, 409);
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      this.setFile(owner, repoName, data.branch, path, content);
      this.writes.push({ method: 'PUT', branch: data.branch, path, content });
      return json({ content: { sha: sha(content) } }, 201);
    }
    return json({}, 404);
  }
}
export function harness(origin = 'https://prototype.example', network, options = {}) {
  const upstream = new FakeGitHub();
  const env = { APP_ORIGIN: origin, GITHUB_CLIENT_ID: 'fake-client', GITHUB_CLIENT_SECRET: 'fake-secret', TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), GITHUB_SCOPE: 'repo', DB: database(), ASSETS: { fetch: async () => new Response('static') } };
  const worker = createWorker(network || upstream.fetch.bind(upstream), options);
  const jar = new Map();
  async function request(path, { method = 'GET', body, headers = {}, cookies = true } = {}) {
    const requestHeaders = new Headers(headers);
    if (cookies) requestHeaders.set('Cookie', [...jar].map(([k,v]) => `${k}=${v}`).join('; '));
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    if (method === 'POST' && !requestHeaders.has('Origin')) requestHeaders.set('Origin', origin);
    const response = await worker.fetch(new Request(`${origin}${path}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
    for (const c of response.headers.getSetCookie()) {
      const [name, value] = c.split(';')[0].split('=');
      if (value) jar.set(name, value); else jar.delete(name);
    }
    return response;
  }
  async function login(code = 'demo') {
    const start = await request('/api/auth/start', { method: 'POST', body: {} });
    const url = new URL((await start.json()).url);
    const callback = await request(`/api/auth/callback?state=${url.searchParams.get('state')}&code=${code}`);
    const session = await (await request('/api/session')).json();
    return { session, callback, state: url.searchParams.get('state') };
  }
  return { upstream, env, worker, jar, request, login };
}
