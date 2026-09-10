/** GitHub adapter: anonymous public reads; authenticated operations use the Worker. */
import * as auth from './auth.js';
const API_BASE = 'https://api.github.com';
export const _internal = { timeoutMs: 15000 };

/**
 * Structured GitHub error. `kind` classifies the failure for the UI.
 * @property {number} status
 * @property {'auth'|'conflict'|'rate-limit'|'not-found'|'network'} kind
 */
export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, kind?: 'auth'|'conflict'|'rate-limit'|'not-found'|'network' }} [meta]
   */
  constructor(message, { status, kind } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.kind = kind;
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Low-level fetch plumbing
// ─────────────────────────────────────────────────────────────────────────

function authHeaders(extra = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...extra };
  return headers;
}

/**
 * Encode a repo-relative path for use in a Contents API URL, preserving '/'
 * as a segment separator (each segment percent-encoded individually so
 * spaces, unicode, and reserved characters round-trip correctly).
 */
function encodePath(path) {
  return String(path)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Issue a request against api.github.com. Never throws for HTTP error
 * statuses (callers decide how to map 304/404/etc.); throws GitHubError
 * kind:'network' on timeout or any fetch-level failure (DNS, offline, CORS).
 * @returns {Promise<Response>}
 */
async function apiFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), _internal.timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      headers: authHeaders(headers),
      body,
      signal: controller.signal,
    });
  } catch {
    // Covers both AbortController-driven timeouts (fetch rejects with an
    // AbortError) and genuine network failures (offline, DNS, CORS). Never
    // surface the underlying error's message verbatim — it's not
    // token-bearing, but keep the mapping uniform and predictable instead.
    throw new GitHubError('GitHub request failed: network error or timeout', { kind: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a non-ok Response into a GitHubError per the frozen status
 * mapping. Reads (and discards) the JSON body, if any, only to distinguish
 * rate-limit 403s from plain auth 403s — never to build a message that
 * could echo a token (GitHub never echoes the Authorization header back).
 * @returns {Promise<GitHubError>}
 */
async function errorFromResponse(resp) {
  let bodyJson = null;
  try {
    const text = await resp.clone().text();
    bodyJson = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON or unreadable body — fall through with bodyJson = null.
  }

  const status = resp.status;
  const apiMessage = (bodyJson && typeof bodyJson.message === 'string') ? bodyJson.message : '';

  let kind = 'network';
  if (status === 401) {
    kind = 'auth';
  } else if (status === 403) {
    const rateLimited =
      resp.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(apiMessage);
    kind = rateLimited ? 'rate-limit' : 'auth';
  } else if (status === 404) {
    kind = 'not-found';
  } else if (status === 409 || status === 422) {
    // 409 = direct sha conflict on Contents API PUT. 422 = validation
    // failure, which for this API's write paths is the sha-mismatch/branch
    // case (FR-GH.4) — treated uniformly as 'conflict' per the frozen
    // status-mapping table.
    kind = 'conflict';
  }

  const message = apiMessage
    ? `GitHub API error (${status}): ${apiMessage}`
    : `GitHub API error (${status})`;
  return new GitHubError(message, { status, kind });
}

/**
 * Base64-decode a GitHub API response, handling UTF-8 multibyte characters.
 * The standard atob() only handles Latin-1; this converts to proper UTF-8.
 * (Same approach as preview/index.html's decodeBase64Utf8.)
 */
function decodeBase64Utf8(b64) {
  return decodeURIComponent(
    atob(String(b64).replace(/\n/g, ''))
      .split('')
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** UTF-8-safe base64 encode, the inverse of decodeBase64Utf8. */
function encodeBase64Utf8(str) {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Contents API
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {{ owner: string, repo: string, ref: string, path: string, etag?: string }} args
 * @returns {Promise<{ content: string, sha: string, etag: string } | 'not-modified' | null>}
 */
export async function getFile({ owner, repo, ref, path, etag } = {}) {
  if (auth.getSession()?.user) {
    const { file } = await service('/api/github/read?' + query({ owner, repo, branch: ref || 'HEAD', path }));
    return file ? { ...file, etag: '' } : null;
  }
  const headers = {};
  if (etag) headers['If-None-Match'] = etag;
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const resp = await apiFetch(`/repos/${owner}/${repo}/contents/${encodePath(path)}${qs}`, { headers });

  if (resp.status === 304) return 'not-modified';
  // 404 is a normal "file doesn't exist" outcome for this contract (callers
  // probe for existence) — not an error.
  if (resp.status === 404) return null;
  if (!resp.ok) throw await errorFromResponse(resp);

  const json = await resp.json();
  if (json.encoding !== 'base64' || typeof json.content !== 'string') {
    throw new GitHubError('Unexpected response shape from GitHub Contents API', {
      status: resp.status,
      kind: 'network',
    });
  }

  return {
    content: decodeBase64Utf8(json.content),
    sha: json.sha,
    etag: resp.headers.get('etag') || '',
  };
}

/**
 * @param {{ owner: string, repo: string, branch: string, path: string, content: string, message: string, sha?: string }} args
 * @returns {Promise<{ sha: string }>}
 */
async function service(path, body) {
  try { return await auth.request(path, body); }
  catch (e) {
    throw new GitHubError(e.message, { status: e.status,
      kind: e.status === 401 || e.status === 403 ? 'auth' : e.status === 404 ? 'not-found' : e.status === 409 || e.status === 422 ? 'conflict' : e.status === 429 ? 'rate-limit' : 'network' });
  }
}
const query = data => new URLSearchParams(data).toString();
export async function putFile({ owner, repo, branch, path, content, message, sha } = {}) {
  return service('/api/github/save', { owner, repo, branch, path, content, message, expectedSha: sha || null });
}

// ─────────────────────────────────────────────────────────────────────────
//  Repo / branch metadata
// ─────────────────────────────────────────────────────────────────────────

/** @param {{ owner: string, repo: string }} args */
export async function getRepo({ owner, repo } = {}) {
  return service('/api/github/repo?' + query({ owner, repo }));
}
export async function listBranches({ owner, repo } = {}) {
  let page = 1; const branches = [];
  while (page) {
    const data = await service('/api/github/branches?' + query({ owner, repo, page }));
    branches.push(...data.items); page = data.nextPage;
  }
  return branches;
}
export async function listRepositories() {
  let page = 1; const repos = [];
  while (page) {
    const data = await service('/api/github/repos?' + query({ page }));
    repos.push(...data.items); page = data.nextPage;
  }
  return repos;
}
export async function getBranchHead({ owner, repo, branch } = {}) {
  return service('/api/github/branch-head?' + query({ owner, repo, branch }));
}
export async function createBranch({ owner, repo, name, fromSha } = {}) {
  return service('/api/github/create-branch', { owner, repo, branch: name, fromSha });
}

/** Resolve slash-containing branch names using actual refs, never by guessing. */
export async function resolveFileURL(ref) {
  let url;
  try { url = new URL(ref); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|edit|raw)\/(.+)$/);
  if (!match) return null;
  const [, owner, repo, rawTail] = match;
  const tail = decodeURIComponent(rawTail).replace(/^refs\/heads\//, '');
  let branches;
  if (auth.getSession()?.user) branches = await listBranches({ owner, repo });
  else {
    branches = []; let page = 1;
    while (page) {
      const response = await apiFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`);
      if (!response.ok) throw await errorFromResponse(response);
      branches.push(...await response.json());
      page = /rel="next"/.test(response.headers.get('Link') || '') ? page + 1 : 0;
    }
  }
  const branch = branches.map(b => b.name).filter(name => tail.startsWith(name + '/')).sort((a, b) => b.length - a.length)[0];
  if (!branch) throw new GitHubError('The file URL does not identify an available branch. Open its branch on GitHub, or use an explicit repository, branch and file path.', { kind: 'not-found', status: 404 });
  return { owner, repo, branch, path: tail.slice(branch.length + 1) };
}
