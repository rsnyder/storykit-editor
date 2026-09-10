import { sourceFields } from '../../../editor/package-validation.js';
import { createWorkspaceRoutes } from './workspace-routes.js';
/** Small same-origin BFF. No browser tokens, arbitrary proxy URLs, or HTML preview. */
const API = 'https://api.github.com';
const OAUTH = 'https://github.com/login/oauth';
const encoder = new TextEncoder();
const MAX_CONTENT_BYTES = 200_000;
const MAX_BODY_BYTES = 1_300_000; // JSON may escape each source character.
const SESSION_SECONDS = 8 * 60 * 60;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}
const fail = (status, code, message, extra) => { throw new HttpError(status, code, message, extra); };
const now = () => Math.floor(Date.now() / 1000);
export function base64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const url64 = bytes => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => url64(crypto.getRandomValues(new Uint8Array(32)));
export const hash = async value => url64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
async function key(env) {
  const bytes = unbase64(env.TOKEN_ENCRYPTION_KEY);
  if (bytes.length !== 32) throw new Error('Invalid encryption key');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), encoder.encode(value));
  return `${base64(iv)}.${base64(new Uint8Array(data))}`;
}
export async function unseal(value, env) {
  const [iv, data] = value.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv) }, await key(env), unbase64(data)));
}
function configured(env) {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY && env.DB);
}
function cookieName(env, type) {
  return `${env.APP_ORIGIN.startsWith('https://') ? '__Host-' : ''}sk_${type}`;
}
function cookie(env, type, value, seconds) {
  return `${cookieName(env, type)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${env.APP_ORIGIN.startsWith('https://') ? '; Secure' : ''}`;
}
function readCookie(request, env, type) {
  const name = `${cookieName(env, type)}=`;
  return (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(name))?.slice(name.length) || '';
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
function secure(response, editor = false, localViewer = false, assetOrigin = '') {
  const result = new Response(response.body, response);
  const headers = result.headers;
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (editor) headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://esm.sh https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://rsnyder.github.io 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https:; img-src 'self' https: data: blob:; font-src 'self' https: data:; frame-src https: about: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (localViewer && response.status < 400) {
    // This one public component is embedded by an opaque preview frame. It
    // remains sandboxed without same-origin access to the editor/session.
    headers.delete('X-Frame-Options');
    headers.set('Content-Security-Policy', "sandbox allow-scripts allow-popups allow-downloads; default-src 'none'; script-src 'self' https://cdn.jsdelivr.net https://unpkg.com 'unsafe-inline'; style-src https: 'unsafe-inline'; connect-src https: blob:; img-src https: data: blob:; font-src https: data:; object-src 'none'; base-uri 'none'; form-action 'none'");
    // WebKit resolves 'self' against the sandbox's opaque origin. Explicitly
    // allow only the public scripts shipped beside these viewer components.
    if (assetOrigin) headers.set('Content-Security-Policy', headers.get('Content-Security-Policy')
      .replace("script-src 'self' ", `script-src 'self' ${assetOrigin}/assets/js/ `));
  }
  headers.set('Permissions-Policy' , 'camera=(), microphone=(), geolocation=()');
  return result;
}
async function bodyOf(request, maximum = MAX_BODY_BYTES) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) fail(415, 'content_type', 'Expected JSON.');
  if (Number(request.headers.get('Content-Length')) > maximum) fail(413, 'too_large', 'Request exceeds the supported size limit.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_json', 'Missing request body.');
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) { await reader.cancel(); fail(413, 'too_large', 'Request exceeds the supported size limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { fail(400, 'invalid_json', 'Invalid JSON request.'); }
}
function checkOrigin(request, env) {
  if (request.headers.get('Origin') !== env.APP_ORIGIN) fail(403, 'origin', 'This request must come from the editor.');
}
function repoParts(data) {
  const { owner, repo } = data;
  if (typeof owner !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(owner) || typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || ['.', '..'].includes(repo)) fail(400, 'repository', 'Choose a valid repository.');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
function branchName(branch) {
  if (typeof branch !== 'string' || !branch || branch.length > 200 || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.startsWith('-') || branch === '@' || branch.split('/').some(x => !x || x.startsWith('.') || x.endsWith('.') || x.endsWith('.lock'))) fail(400, 'branch', 'Choose a valid branch name. Names such as drafts/my-story are supported.');
  return branch;
}
function filePath(path) {
  if (typeof path !== 'string' || path.length > 500 || !/\.(md|markdown)$/i.test(path) || /[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.github' || p.toLowerCase() === '.git')) fail(400, 'path', 'Use a Markdown file path, for example _posts/2026-09-06-my-story.md.');
  return path.split('/').map(encodeURIComponent).join('/');
}
function pageNumber(value) {
  if (!/^\d+$/.test(String(value || '1'))) fail(400, 'page', 'Invalid page.');
  const page = Number(value || 1);
  if (page < 1 || page > 10000) fail(400, 'page', 'Invalid page.');
  return page;
}
function hasNext(response) { return /rel="next"/.test(response.headers.get('Link') || ''); }

/** Injectable network is a test seam. Deployed default always uses global fetch. */
export function createWorker(network = (...args) => fetch(...args), options = {}) {
  async function upstream(url, options = {}) {
    try {
      // Workers must not follow redirects carrying GitHub credentials.
      const response = await network(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400) throw new Error('Upstream redirect refused');
      return response;
    }
    catch (error) {
      const detail = String(error?.message || '').toLowerCase();
      const kind = detail.includes('redirect') ? 'redirect' : detail.includes('timeout') ? 'timeout' : detail.includes('signal') ? 'signal' : 'request';
      fail(502, 'network', 'GitHub could not be reached. If you were saving, check the file on GitHub before trying again.', { supportCode: `network_${kind}` });
    }
  }
  async function github(session, env, path, options = {}) {
    const response = await upstream(`${API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'StoryKit-auth-prototype', Authorization: `Bearer ${await unseal(session.token, env)}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (response.status === 401) {
      await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(session.id_hash).run();
      fail(401, 'signed_out', 'Your GitHub session expired. Sign in again; your draft is still in this browser.');
    }
    return response;
  }
  function checkGitHub(response) {
    if (response.ok) return;
    if (response.status === 403 || response.status === 429) {
      const limited = response.status === 429 || response.headers.get('X-RateLimit-Remaining') === '0' || response.headers.has('Retry-After');
      fail(limited ? 429 : 403, limited ? 'rate_limit' : 'access', limited ? 'GitHub is limiting requests. Wait and try again.' : 'GitHub refused access. Check organization approval, SSO, repository permissions, or branch protection.');
    }
    if (response.status === 404) fail(404, 'not_found', 'GitHub could not find this repository, branch, or file, or your account cannot access it.');
    if ([409, 422].includes(response.status)) fail(409, 'github_conflict', 'GitHub could not accept this change. Refresh the destination; check branch rules or whether the file changed.');
    fail(502, 'github', 'GitHub could not complete the request. Your local draft is unchanged.');
  }
  async function requireSession(request, env, csrf = false) {
    const sid = readCookie(request, env, 'session');
    if (!sid) fail(401, 'signed_out', 'Sign in with GitHub to continue.');
    const session = await env.DB.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?').bind(await hash(sid), now()).first();
    if (!session) fail(401, 'signed_out', 'Your session expired. Sign in again; your local draft is unchanged.');
    if (csrf && request.headers.get('X-CSRF-Token') !== session.csrf) fail(403, 'csrf', 'Refresh this page before trying again.');
    return session;
  }
  async function start(request, env) {
    checkOrigin(request, env);
    if (!configured(env)) fail(503, 'not_configured', 'GitHub sign-in is not configured yet. You can keep writing and download your draft.');
    const input = await bodyOf(request);
    const returnPath = input.returnTo === '/editor/' ? '/editor/' : '/';
    // Delete the previous transaction from this browser; callbacks are one-use.
    const previous = readCookie(request, env, 'oauth');
    if (previous) await env.DB.prepare('DELETE FROM oauth_states WHERE browser_hash = ?').bind(await hash(previous)).run();
    const state = random(), browser = random(), verifier = random();
    await env.DB.prepare('INSERT INTO oauth_states (state_hash, browser_hash, verifier, expires_at, return_path) VALUES (?, ?, ?, ?, ?)')
      .bind(await hash(state), await hash(browser), await seal(verifier, env), now() + 600, returnPath).run();
    const url = new URL(`${OAUTH}/authorize`);
    url.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.APP_ORIGIN}/api/auth/callback`, scope: env.GITHUB_SCOPE || 'repo', state, code_challenge: await hash(verifier), code_challenge_method: 'S256', prompt: 'select_account' });
    return json({ url: url.href }, 200, { 'Set-Cookie': cookie(env, 'oauth', browser, 600) });
  }
  async function callback(request, env) {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') || '';
    const browser = readCookie(request, env, 'oauth');
    const clear = cookie(env, 'oauth', '', 0);
    if (!state || !browser) return redirect('/?auth=invalid', [clear]);
    // DELETE RETURNING is an atomic consume, including across Worker instances.
    const transaction = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING verifier, return_path')
      .bind(await hash(state), await hash(browser), now()).first();
    if (!transaction) return redirect('/?auth=invalid', [clear]);
    const landing = transaction.return_path === '/editor/' ? '/editor/' : '/';
    if (url.searchParams.has('error')) return redirect(`${landing}?auth=cancelled`, [clear]);
    const code = url.searchParams.get('code');
    if (!code) return redirect(`${landing}?auth=invalid`, [clear]);
    let failure = 'pkce_decrypt';
    try {
      const verifier = await unseal(transaction.verifier, env);
      failure = 'token_exchange';
      const response = await upstream(`${OAUTH}/access_token`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'StoryKit-auth-prototype' },
        body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code,
          redirect_uri: `${env.APP_ORIGIN}/api/auth/callback`, code_verifier: verifier }).toString(),
      });
      failure = response.ok ? 'token_response' : `token_http_${response.status}`;
      const grant = await response.json();
      if (!response.ok || !grant.access_token || grant.error) {
        // Only expose known error identifiers, never upstream text or credentials.
        if (['incorrect_client_credentials', 'bad_verification_code', 'redirect_uri_mismatch'].includes(grant.error)) failure = grant.error;
        throw new Error('OAuth failed');
      }
      const scopes = String(grant.scope || '').split(/[ ,]+/);
      const requiredScope = env.GITHUB_SCOPE || 'repo';
      if (!scopes.includes(requiredScope) && !(requiredScope === 'public_repo' && scopes.includes('repo'))) return redirect(`${landing}?auth=scope`, [clear]);
      failure = 'identity';
      const identityResponse = await upstream(`${API}/user`, { headers: { Authorization: `Bearer ${grant.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'StoryKit-auth-prototype' } });
      const user = await identityResponse.json();
      if (!identityResponse.ok || !Number.isSafeInteger(user.id) || typeof user.login !== 'string') throw new Error('Identity failed');
      failure = 'session';
      const sid = random();
      const seconds = Math.min(SESSION_SECONDS, Number(grant.expires_in) || SESSION_SECONDS);
      const previous = readCookie(request, env, 'session');
      if (previous) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await hash(previous)).run();
      await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, login, token, csrf, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(await hash(sid), user.id, user.login, await seal(grant.access_token, env), random(), now() + seconds).run();
      // Prototype deliberately reauthenticates at expiry; no refresh token retained.
      return redirect(`${landing}?auth=success`, [clear, cookie(env, 'session', sid, seconds)]);
    } catch (error) { return redirect(`${landing}?auth=failed&reason=${error instanceof HttpError && error.code === 'network' ? error.extra.supportCode : failure}`, [clear]); }
  }
  async function repository(session, env, data) {
    const prefix = repoParts(data);
    const response = await github(session, env, prefix);
    checkGitHub(response);
    const repo = await response.json();
    if (!repo.permissions?.push || repo.archived || repo.disabled) fail(403, 'read_only', 'This repository is not writable with your current GitHub account.');
    return { prefix, repo };
  }
  async function readFile(session, env, prefix, path, branch) {
    const response = await github(session, env, `${prefix}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    if (response.status === 404) return null;
    checkGitHub(response);
    const file = await response.json();
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > MAX_CONTENT_BYTES) fail(422, 'unsupported_file', 'Choose a Markdown file smaller than 200 KB.');
    return { sha: file.sha, content: new TextDecoder('utf-8', { fatal: true }).decode(unbase64(file.content.replace(/\s/g, ''))) };
  }
  async function save(request, session, env) {
    const data = await bodyOf(request);
    const { owner, repo: repoName, branch, path, content, expectedSha, createBranch } = data;
    const encoded = filePath(path);
    branchName(branch);
    if (typeof content !== 'string' || encoder.encode(content).length > MAX_CONTENT_BYTES) fail(413, 'too_large', 'Request exceeds the supported size limit.');
    if (expectedSha !== null && (typeof expectedSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(expectedSha))) fail(400, 'sha', 'Review the destination before saving.');
    const { prefix, repo } = await repository(session, env, data);
    const lockKey = `${session.user_id}/${owner.toLowerCase()}/${repoName.toLowerCase()}/${branch}`;
    const nonce = random();
    const lease = await env.DB.prepare('INSERT INTO write_locks (lock_key, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT(lock_key) DO UPDATE SET nonce = excluded.nonce, expires_at = excluded.expires_at WHERE write_locks.expires_at < ? RETURNING nonce')
      .bind(lockKey, nonce, now() + 120, now()).first();
    if (!lease) fail(409, 'busy', 'Another save to this branch is still running. Wait before trying again.');
    try {
      const branchResponse = await github(session, env, `${prefix}/branches/${encodeURIComponent(branch)}`);
      let sourceBranch = branch;
      let head = null;
      if (branchResponse.status === 404) {
        if (!createBranch) fail(404, 'branch_missing', 'This branch no longer exists. Choose a branch again.');
        sourceBranch = repo.default_branch;
        const source = await github(session, env, `${prefix}/branches/${encodeURIComponent(sourceBranch)}`);
        if ([404, 409].includes(source.status)) fail(422, 'empty_repo', 'Initialize this repository with a README on GitHub, then refresh its branches.');
        checkGitHub(source);
        head = (await source.json()).commit.sha;
      } else { checkGitHub(branchResponse); }
      const current = await readFile(session, env, prefix, encoded, sourceBranch);
      if (sourceFields(content).storykit_workspace || sourceFields(current?.content || '').storykit_workspace) fail(409, 'workspace_required', 'Use a compatible editor to save this story and its managed files together.');
      if ((current?.sha || null) !== expectedSha) fail(409, 'file_changed', 'The file changed on GitHub. Review it again before saving.');
      if (current?.content === content && !head) return json({ sha: current.sha, unchanged: true, url: `https://github.com/${owner}/${repoName}/blob/${encodeURIComponent(branch)}/${encoded}` });
      if (head) {
        const created = await github(session, env, `${prefix}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head }) });
        checkGitHub(created);
      }
      const response = await github(session, env, `${prefix}/contents/${encoded}`, {
        method: 'PUT', body: JSON.stringify({ branch, content: base64(encoder.encode(content)), message: typeof data.message === 'string' && data.message.trim() ? data.message.trim().slice(0, 500) : `Update ${path} from StoryKit`, ...(current ? { sha: current.sha } : {}) }),
      });
      checkGitHub(response);
      const result = await response.json();
      return json({ sha: result.content.sha, url: `https://github.com/${owner}/${repoName}/blob/${encodeURIComponent(branch)}/${encoded}` });
    } finally { await env.DB.prepare('DELETE FROM write_locks WHERE lock_key = ? AND nonce = ?').bind(lockKey, nonce).run(); }
  }
  const workspaceRoute = createWorkspaceRoutes({github,checkGitHub,repository,repoParts,branchName,bodyOf,json,fail,
    decode: options.decode || (async bytes => (await import('./raster-validation.js')).validateRaster(bytes))});
  async function route(request, env) {
    const url = new URL(request.url);
    if (url.origin !== env.APP_ORIGIN) fail(400, 'host', 'Use the configured prototype address.');
    if (env.EDITOR_ONLY === 'true' && url.pathname === '/') return redirect(`/editor/${url.search}`);
    if (!url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'method', 'Method not allowed.');
      return env.ASSETS.fetch(request);
    }
    if (request.method === 'POST') checkOrigin(request, env);
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /api/github/capabilities') return json({ workspace: 1, localImage: 1, localData: 1 });
    if (route === 'POST /api/auth/start') return start(request, env);
    if (route === 'GET /api/auth/callback') return callback(request, env);
    if (route === 'GET /api/session') {
      let session = null;
      if (configured(env)) {
        try { session = await requireSession(request, env); }
        catch (error) { if (error.status !== 401) throw error; }
      }
      return json({ configured: configured(env), scope: env.GITHUB_SCOPE || 'repo', user: session ? { id: session.user_id, login: session.login } : null, csrf: session?.csrf || null, expiresAt: session?.expires_at || null });
    }
    if (!configured(env)) fail(503, 'not_configured', 'GitHub sign-in is not configured yet.');
    const session = await requireSession(request, env, request.method === 'POST');
    if (route === 'POST /api/auth/logout') {
      await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(session.id_hash).run();
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(env, 'session', '', 0) });
    }
    if (route === 'GET /api/github/repos') {
      const page = pageNumber(url.searchParams.get('page'));
      const response = await github(session, env, `/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=${page}`);
      checkGitHub(response);
      const repos = (await response.json()).filter(repo => repo.permissions?.push && !repo.archived && !repo.disabled && ((env.GITHUB_SCOPE || 'repo') === 'repo' || !repo.private));
      return json({ items: repos.map(repo => ({ id: repo.id, owner: repo.owner.login, name: repo.name, fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch })), nextPage: hasNext(response) ? page + 1 : null });
    }
    if (route === 'GET /api/github/repo') {
      const { repo } = await repository(session, env, Object.fromEntries(url.searchParams));
      return json({ default_branch: repo.default_branch, permissions: { push: true } });
    }
    if (route === 'GET /api/github/read') {
      const data = Object.fromEntries(url.searchParams), prefix = repoParts(data);
      branchName(data.branch);
      // Reads also support the editor's repository templates/configuration.
      if (!data.path || data.path.length > 500 || /[\\\x00-\x1f]/.test(data.path) || data.path.split('/').some(p => !p || p === '.' || p === '..')) fail(400, 'path', 'Invalid file path.');
      return json({ file: await readFile(session, env, prefix, data.path.split('/').map(encodeURIComponent).join('/'), data.branch) });
    }
    if (route === 'GET /api/github/branch-head') {
      const data = Object.fromEntries(url.searchParams), prefix = repoParts(data);
      branchName(data.branch);
      const response = await github(session, env, `${prefix}/branches/${encodeURIComponent(data.branch)}`);
      checkGitHub(response);
      return json({ sha: (await response.json()).commit.sha });
    }
    if (route === 'POST /api/github/create-branch') {
      const data = await bodyOf(request);
      branchName(data.branch);
      if (typeof data.fromSha !== 'string' || !/^[a-f0-9]{40}$/.test(data.fromSha)) fail(400, 'sha', 'Invalid source commit.');
      const { prefix } = await repository(session, env, data);
      const response = await github(session, env, `${prefix}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${data.branch}`, sha: data.fromSha }) });
      checkGitHub(response);
      const result = await response.json();
      return json({ sha: result.object.sha, ref: result.ref });
    }
    if (route === 'GET /api/github/branches') {
      const data = Object.fromEntries(url.searchParams);
      const prefix = repoParts(data), page = pageNumber(data.page);
      const response = await github(session, env, `${prefix}/branches?per_page=100&page=${page}`);
      if (response.status === 409) return json({ items: [], nextPage: null });
      checkGitHub(response);
      return json({ items: (await response.json()).map(b => ({ name: b.name, protected: !!b.protected })), nextPage: hasNext(response) ? page + 1 : null });
    }
    if (route === 'GET /api/github/file') {
      const data = Object.fromEntries(url.searchParams);
      branchName(data.branch);
      const encoded = filePath(data.path);
      const { prefix } = await repository(session, env, data);
      const branch = await github(session, env, `${prefix}/branches/${encodeURIComponent(data.branch)}`);
      checkGitHub(branch);
      return json({ file: await readFile(session, env, prefix, encoded, data.branch) });
    }
    if (url.pathname.startsWith('/api/github/workspace') || url.pathname === '/api/github/asset') {
      const response = await workspaceRoute(request, session, env, url);
      if (response) return response;
    }
    if (route === 'POST /api/github/save') return save(request, session, env);
    fail(404, 'route', 'Unknown API route.');
  }
  return {
    async fetch(request, env) {
      try {
        const path = new URL(request.url).pathname;
        const response = secure(await route(request, env), path.startsWith('/editor/'), /^\/assets\/components\/(?:image|map)(?:\.html)?$/.test(path), new URL(request.url).origin);
        if (path.startsWith('/assets/js/') && response.ok) response.headers.set('Access-Control-Allow-Origin', '*');
        return response;
      }
      catch (error) {
        // Never log/echo upstream payloads, OAuth codes, credentials, or draft text.
        return secure(json({ error: { code: error.code || 'internal', message: error instanceof HttpError ? error.message : 'The service could not complete this request. Your local draft is unchanged.', ...(error.extra || {}) } }, error.status || 500));
      }
    },
    async scheduled(_event, env) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now()),
        env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
        env.DB.prepare('DELETE FROM write_locks WHERE expires_at <= ?').bind(now()),
      ]);
    },
  };
}
export default createWorker();
