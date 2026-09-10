/** Same-origin session client. Credentials stay in the Worker. */
let session = null;
export const getSession = () => session;
export async function request(path, body) {
  let response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path.startsWith('/api/github/workspace') ? 120000 : 15000) });
  } catch { throw Object.assign(new Error('Connection lost. Your local draft is unchanged. Check GitHub before retrying a save.'), { status: 0 }); }
  let data;
  try { data = await response.json(); } catch { const packageRequest=path.startsWith('/api/github/workspace')||path.startsWith('/api/github/asset'); throw Object.assign(new Error(packageRequest?'The package service returned an unreadable response. Your local story is retained.':'GitHub sign-in is unavailable on this editor host.'), { status: response.status >= 400 ? response.status : 503 }); }
  if (!response.ok) {
    if (response.status === 401) session = null;
    throw Object.assign(new Error(data.error?.message || 'GitHub request failed.'), { status: response.status, code: data.error?.code, details: data.error });
  }
  return data;
}
export async function refresh() {
  try { session = await request('/api/session'); }
  catch { session = { configured: false, user: null }; }
  return session;
}
export async function signIn() {
  const { url } = await request('/api/auth/start', { returnTo: '/editor/' });
  location.assign(url);
}
export async function signOut() { await request('/api/auth/logout', {}); session = null; }
