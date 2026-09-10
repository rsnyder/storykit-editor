/** Session identity only. GitHub access tokens never reach this module. */
export class APIError extends Error {
  constructor(message, status, code) { super(message); Object.assign(this, { status, code }); }
}
export function createAuth() {
  let session = null;
  async function request(path, { body, signal } = {}) {
    let response;
    try {
      response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new APIError('Connection lost. Your draft stays in this browser. If saving, check GitHub before trying again.', 0, 'network');
    }
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) session = null;
      throw new APIError(data.error?.message || 'The request failed.', response.status, data.error?.code);
    }
    return data;
  }
  return {
    request,
    get session() { return session; },
    async refresh() { session = await request('/api/session'); return session; },
    async signIn() { const { url } = await request('/api/auth/start', { body: {} }); location.assign(url); },
    async signOut() { await request('/api/auth/logout', { body: {} }); session = null; },
  };
}
