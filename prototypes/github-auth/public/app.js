import { createAuth } from './auth.js';
const $ = id => document.getElementById(id);
const auth = createAuth();
const DRAFT_KEY = 'storykit-auth-prototype-draft-v1';
const HISTORY_KEY = 'storykit-auth-prototype-history-v1';
const title = $('title'), content = $('content'), path = $('path');
let repos = [], selected = null, busy = false, generation = 0, repoController, branchController;
let review = null, recovery = [], pathEdited = false, lastSavedContent = null;
const initial = '# A place worth remembering\n\nEvery story starts with a detail. A building on a familiar street. A photograph in an archive. A landscape that changes over time.\n\nWrite yours here. This draft is saved in this browser as you type.\n';

function feedback(message, type = '') {
  $('feedback').textContent = message;
  $('feedback').className = `feedback ${type}`;
  $('feedback').hidden = !message;
}
function suggestedPath() {
  const slug = title.value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,80) || 'my-story';
  return `_posts/${new Date().toISOString().slice(0,10)}-${slug}.md`;
}
function persist() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: title.value, content: content.value, path: path.value, pathEdited }));
    $('local-status').textContent = 'Saved in this browser';
    return true;
  } catch {
    $('local-status').textContent = 'Local saving unavailable — download your draft';
    feedback('Your browser could not save this draft. Download it before signing in or leaving this page.', 'error');
    return false;
  }
}
function count() {
  const words = content.value.trim().split(/\s+/).filter(Boolean).length;
  $('word-count').textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
}
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderRecovery() {
  $('history-list').replaceChildren(...recovery.map(item => {
    const li = document.createElement('li'), button = document.createElement('button');
    button.className = 'text-button'; button.textContent = `${new Date(item.date).toLocaleString()} · ${item.title || 'Untitled'}`;
    button.addEventListener('click', () => download(item.content, 'storykit-recovery.md'));
    li.append(button); return li;
  }));
}
function snapshot() {
  const next = [{ title: title.value, content: content.value, date: new Date().toISOString() }, ...recovery].slice(0,10);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); // Abort save if recovery cannot persist.
  recovery = next; renderRecovery();
}
function enabled() {
  $('destination-fields').disabled = busy;
  $('sign-out').disabled = busy;
  $('review').disabled = busy || !selected || !$('branch').value || ($('create-branch').checked && !$('new-branch').value.trim()) || !path.value.trim();
}
function invalidate() {
  review = null;
  $('saved-link').hidden = true;
  enabled();
}
function resetAccount() {
  generation++;
  repoController?.abort(); branchController?.abort();
  repos = []; selected = null; review = null;
  $('repos').replaceChildren(); $('branch').replaceChildren();
  $('branch-fields').hidden = true;
  $('repo-search').value = '';
  $('saved-link').hidden = true;
}
function accountUI() {
  const session = auth.session;
  $('signed-out').hidden = !!session?.user;
  $('signed-in').hidden = !session?.user;
  $('sign-in').disabled = session?.configured === false;
  $('configuration-note').hidden = session?.configured !== false;
  $('identity').textContent = session?.user ? `Signed in as @${session.user.login}` : '';
  $('scope-note').textContent = session?.scope === 'public_repo' ? 'GitHub will ask you to authorize access to public repositories.' : 'GitHub will ask you to authorize access to public and private repositories. This grant is broader than the repository you select here.';
  $('demo-banner').hidden = !session?.demo;
  enabled();
}
async function handleError(error) {
  if (error.name === 'AbortError') return;
  if (error.status === 401) { resetAccount(); accountUI(); }
  feedback(error.message || 'Something went wrong. Your local draft is unchanged.', 'error');
}
function renderRepos() {
  const query = $('repo-search').value.trim().toLowerCase();
  const visible = repos.filter(r => r.fullName.toLowerCase().includes(query));
  $('repos').replaceChildren(...visible.map(repo => {
    const option = new Option(`${repo.fullName} · ${repo.private ? 'private' : 'public'}`, String(repo.id));
    option.selected = selected?.id === repo.id; return option;
  }));
  // Do not imply that the browser-selected first option has been chosen by the user.
  if (!visible.some(repo => repo.id === selected?.id)) $('repos').selectedIndex = -1;
}
async function loadRepos() {
  repoController?.abort(); branchController?.abort();
  const controller = repoController = new AbortController(), run = ++generation;
  repos = []; selected = null; $('branch-fields').hidden = true; invalidate(); renderRepos();
  $('repo-status').textContent = 'Finding repositories you can write to…';
  try {
    let page = 1;
    while (page) {
      const result = await auth.request(`/api/github/repos?page=${page}`, { signal: controller.signal });
      if (run !== generation) return;
      const seen = new Set(repos.map(repo => repo.id));
      repos.push(...result.items.filter(repo => !seen.has(repo.id)));
      renderRepos(); page = result.nextPage;
      $('repo-status').textContent = `${repos.length} writable repositories${page ? ' · still loading…' : ''}`;
    }
    if (!repos.length) $('repo-status').textContent = 'No writable repositories found. See access guidance below.';
  } catch (error) {
    if (run !== generation || error.name === 'AbortError') return;
    $('repo-status').textContent = 'Repository list could not finish loading. Refresh to try again.';
    await handleError(error);
  }
}
async function chooseRepo() {
  selected = repos.find(repo => String(repo.id) === $('repos').value) || null;
  branchController?.abort(); invalidate();
  $('branch').replaceChildren(); $('create-branch').checked = false; $('new-branch-field').hidden = true;
  if (!selected) { $('branch-fields').hidden = true; return; }
  $('branch-fields').hidden = false;
  $('branch-status').textContent = 'Loading branches…';
  const repo = selected, controller = branchController = new AbortController();
  try {
    let page = 1; const branches = [];
    while (page) {
      const result = await auth.request(`/api/github/branches?${new URLSearchParams({ owner: repo.owner, repo: repo.name, page })}`, { signal: controller.signal });
      if (controller.signal.aborted || selected?.id !== repo.id) return;
      branches.push(...result.items); page = result.nextPage;
    }
    $('branch').replaceChildren(...branches.map(branch => new Option(`${branch.name}${branch.protected ? ' · protected' : ''}`, branch.name)));
    if (branches.some(branch => branch.name === repo.defaultBranch)) $('branch').value = repo.defaultBranch;
    $('branch-status').textContent = branches.length ? `${branches.length} ${branches.length === 1 ? 'branch' : 'branches'} · default: ${repo.defaultBranch}` : 'This repository is empty. Add a README on GitHub, then refresh.';
    enabled();
  } catch (error) {
    if (controller.signal.aborted || selected?.id !== repo.id) return;
    $('branch-status').textContent = 'Could not load branches. Select the repository again to retry.';
    await handleError(error);
  }
}
async function reviewDestination() {
  if (!selected || busy || !persist()) return;
  busy = true; enabled(); feedback('Checking the destination…'); $('saved-link').hidden = true;
  const repo = selected;
  const creating = $('create-branch').checked;
  const destination = { owner: repo.owner, repo: repo.name, branch: creating ? $('new-branch').value.trim() : $('branch').value, path: path.value.trim(), createBranch: creating };
  try {
    const result = await auth.request(`/api/github/file?${new URLSearchParams({ ...destination, branch: creating ? repo.defaultBranch : destination.branch })}`);
    review = { ...destination, expectedSha: result.file?.sha || null };
    $('destination-summary').textContent = `${repo.fullName}\n${destination.branch}${creating ? ' (new branch)' : ''}\n${destination.path}`;
    $('file-note').textContent = result.file ? 'This file already exists. Saving will replace its GitHub content with your local draft.' : 'This will create a new Markdown file.';
    $('remote-details').hidden = !result.file;
    $('remote-details').open = false;
    $('remote-content').textContent = result.file?.content || '';
    $('confirm-save').textContent = result.file ? 'Replace GitHub copy' : 'Save to GitHub';
    feedback(''); $('confirm-dialog').showModal(); $('cancel-save').focus();
  } catch (error) { await handleError(error); }
  finally { busy = false; enabled(); }
}
async function save() {
  if (!review || busy) return;
  const destination = { ...review }, sent = content.value;
  if (!persist()) return;
  try { snapshot(); } catch { feedback('Could not save a recovery copy. Download your draft before saving to GitHub.', 'error'); $('confirm-dialog').close(); return; }
  $('confirm-dialog').close(); busy = true; enabled(); feedback('Saving to GitHub…');
  try {
    const result = await auth.request('/api/github/save', { body: { ...destination, content: sent } });
    lastSavedContent = sent;
    const changed = content.value !== sent;
    feedback(`${result.unchanged ? 'GitHub already has this copy.' : 'Saved to GitHub.'}${changed ? ' You have newer local edits to save.' : ' Your local draft and GitHub copy match.'}`, 'success');
    $('saved-link').href = result.url; $('saved-link').hidden = false;
    if (destination.createBranch) {
      $('branch').add(new Option(destination.branch, destination.branch));
      $('branch').value = destination.branch;
      $('create-branch').checked = false; $('new-branch-field').hidden = true;
    }
  } catch (error) { await handleError(error); }
  finally { review = null; busy = false; enabled(); }
}

try {
  const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  title.value = typeof draft?.title === 'string' ? draft.title : 'A place worth remembering';
  content.value = typeof draft?.content === 'string' ? draft.content : initial;
  pathEdited = !!draft?.pathEdited;
  path.value = typeof draft?.path === 'string' ? draft.path : suggestedPath();
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  recovery = Array.isArray(history) ? history.filter(x => typeof x.content === 'string' && typeof x.date === 'string').slice(0,10) : [];
} catch {
  feedback('The saved draft could not be read. Avoid closing this page if it contains work you need; download a copy.', 'error');
}
count(); renderRecovery();
content.addEventListener('input', () => {
  persist(); count();
  if (lastSavedContent !== null && content.value !== lastSavedContent && !busy) feedback('Saved locally. You have changes to save to GitHub.');
});
title.addEventListener('input', () => { if (!pathEdited) path.value = suggestedPath(); persist(); invalidate(); });
path.addEventListener('input', () => { pathEdited = true; persist(); invalidate(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
window.addEventListener('pagehide', persist);
$('download').addEventListener('click', () => download(content.value, path.value.split('/').pop() || 'story.md'));
$('sign-in').addEventListener('click', async () => {
  if (!persist()) return;
  $('sign-in').disabled = true;
  try { await auth.signIn(); } catch (error) { await handleError(error); $('sign-in').disabled = false; }
});
$('sign-out').addEventListener('click', async () => {
  if (busy) return;
  busy = true; enabled();
  try { await auth.signOut(); resetAccount(); accountUI(); feedback('Signed out. Your draft and recovery copies remain in this browser.'); }
  catch (error) { await handleError(error); }
  finally { busy = false; enabled(); }
});
$('repo-search').addEventListener('input', renderRepos);
$('repos').addEventListener('change', chooseRepo);
$('refresh').addEventListener('click', loadRepos);
$('branch').addEventListener('change', invalidate);
$('create-branch').addEventListener('change', () => { $('new-branch-field').hidden = !$('create-branch').checked; invalidate(); });
$('new-branch').addEventListener('input', invalidate);
$('review').addEventListener('click', reviewDestination);
$('cancel-save').addEventListener('click', () => $('confirm-dialog').close());
$('confirm-dialog').addEventListener('cancel', () => { review = null; });
$('confirm-save').addEventListener('click', save);

const outcome = new URL(location.href).searchParams.get('auth');
const authReason = new URL(location.href).searchParams.get('reason');
if (outcome) {
  history.replaceState(null, '', '/');
  const messages = { success: 'Signed in. Choose a repository for your draft.', cancelled: 'Sign-in canceled. Keep writing here whenever you like.', invalid: 'That sign-in link expired or was already used. Please sign in again.', failed: 'GitHub sign-in could not finish. Please try again.', scope: 'Repository access was not granted. Sign in again to authorize saving.' };
  if (['network_redirect', 'network_timeout', 'network_signal', 'network_request', 'pkce_decrypt', 'token_exchange', 'token_response', 'incorrect_client_credentials', 'bad_verification_code', 'redirect_uri_mismatch', 'identity', 'session'].includes(authReason) || /^token_http_[1-5][0-9]{2}$/.test(authReason || '')) {
    messages.failed += ` Support code: ${authReason}.`;
  }
  feedback(messages[outcome] || 'You can continue writing here.', ['success','cancelled'].includes(outcome) ? '' : 'error');
}
try { await auth.refresh(); accountUI(); if (auth.session?.user) await loadRepos(); }
catch (error) { accountUI(); await handleError(error); }
