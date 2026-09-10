# StoryKit GitHub sign-in prototype

A separate browser-first authoring experiment: write locally → sign in with
GitHub → find a writable repository → review a branch/file → explicitly save.
The production editor is unchanged. Both Jekyll configurations exclude
`prototypes/` from published story sites.

## Try it locally without GitHub setup

Requires Node.js 22.13 or later. From this directory:

```sh
npm run demo
```

Open http://127.0.0.1:8787. The gold banner identifies **LOCAL DEMO**. The
simulated authorization page lets you continue as either of two demo accounts
or cancel. Choose `community/shared-stories` to exercise collaborator access
and a default branch named `trunk`.

The demo uses the real Worker callback/session/save logic with a local fake
GitHub API and in-memory SQLite. It cannot make real GitHub requests or commits.
The fake repository resets when the demo server stops; local drafts persist in
the browser. It listens only on loopback, validates the Host header, and is never
included in the Cloudflare bundle. Use `PORT=8788 npm run demo` for another port
(browser storage is separate for each origin, including the port).

Useful cases:

- Cancel login after typing, then reload: the draft remains.
- Sign in, search `community`, choose a destination, review, and save.
- In `demo-author/field-notes`, choose `_posts/existing.md` to review replacement.
- Select `protected` to see a write refusal; choose a new `drafts/...` branch to save.
- Sign out, then choose the other account: repository selection is cleared.
- Continue editing while a save is pending: newer local text remains intact.

## Staging deployment

Provisioned on 2026-09-06:

- Worker: `storykit-auth-prototype`
- URL: https://storykit-auth-prototype.ron-f9a.workers.dev
- D1: `storykit-auth-prototype` (`ca312f57-8fb2-4f38-a9f2-b802e7c90a00`)
- Schema applied; `TOKEN_ENCRYPTION_KEY` installed as a Worker secret.
- GitHub OAuth App [StoryKit Auth Prototype](https://github.com/settings/applications/3841425)
  is registered, its client secret is installed as an encrypted Worker secret,
  and live sign-in is enabled. The full sign-in and authenticated return have
  been verified in Chrome, with 29 writable repositories listed for the test account.

Staging configuration is in the ignored `wrangler.staging.jsonc`. It contains
deployment identifiers, never credentials. The checked-in `wrangler.jsonc` is
a portable local template; its placeholder database ID must not be used remotely.

### Finish GitHub setup

Create a separate [GitHub OAuth App](https://github.com/settings/applications/new)
with these exact settings:

| Setting | Value |
| --- | --- |
| Application name | StoryKit Auth Prototype |
| Homepage | `https://storykit-auth-prototype.ron-f9a.workers.dev` |
| Redirect URI | `https://storykit-auth-prototype.ron-f9a.workers.dev/api/auth/callback` |
| Wildcard matching | Off |
| Device flow | Off |
| Expire user access tokens | On |

After registering, create a Client Secret and run this in your own terminal:

```sh
npm run configure:github
```

The setup command asks for the public Client ID and then the Client Secret in
a hidden prompt. It sends the secret directly to Wrangler's stdin, stores it
in Workers Secrets, updates the ignored staging config with the Client ID,
and deploys. Do not paste the secret into chat, source files, or a shell command.
It never writes the secret to disk. This command requires a logged-in Wrangler
and the encryption key provisioned above.

Visit staging, sign in, and verify owner/collaborator/organization results.
Use a disposable repository for the first real commit. Organization OAuth
restrictions and SSO may require additional approval; sign-in does not bypass them.
The OAuth `repo` scope grants broad public/private repository access, not just
the repository selected in StoryKit.

For a different Cloudflare account, copy `wrangler.jsonc` to the ignored
`wrangler.staging.jsonc`, set the account, deployed HTTPS origin and database ID,
then run:

```sh
npm ci
npx wrangler login
npx wrangler d1 create storykit-auth-prototype
npx wrangler d1 migrations apply DB --remote --config wrangler.staging.jsonc
npx wrangler deploy --config wrangler.staging.jsonc
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY --config wrangler.staging.jsonc
npm run configure:github
```

Use the actual resulting staging origin for the OAuth registration. Do not rotate
an existing encryption key with this setup command: doing so makes existing
session tokens unreadable. Deliberate key rotation requires invalidating sessions.

## Local development with a real OAuth App

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Set a separate development OAuth Client ID in the local Wrangler config and
put its secret plus a generated 32-byte base64 encryption key in `.dev.vars`.
Register `http://127.0.0.1:8787/api/auth/callback` as its exact redirect URI.
The HTTP local session cookie omits Secure; deployed HTTPS cookies always use
Secure and the `__Host-` prefix. Use separate apps/databases/secrets for staging
and development. Never configure a remote deployment with an HTTP origin.

## Implementation map

| File | Role |
| --- | --- |
| `src/worker.js` | OAuth + PKCE, one-use browser-bound state, sessions, AES-GCM token encryption, constrained GitHub endpoints |
| `public/auth.js` | Reusable browser session client; identity and CSRF only |
| `public/app.js` | Local draft, recovery copies, paginated searchable repos/branches, review and save |
| `migrations/0001_auth.sql` | D1 auth state, sessions, and cross-request write leases |
| `tests/support.mjs`, `tools/demo-server.mjs` | Local-only fake upstream and SQLite adapter |
| `tools/configure-github.mjs` | Operator setup without secrets in files or command arguments |

Routes: `POST /api/auth/start`, `GET /api/auth/callback`, `GET /api/session`,
`POST /api/auth/logout`, `GET /api/github/repos`, `GET /api/github/branches`,
`GET /api/github/file`, `POST /api/github/save`.

GitHub credentials are encrypted in D1; only a hash of the random session ID is
stored. State is atomically consumed with DELETE RETURNING. All state-changing
API calls check Origin; authenticated writes also check CSRF. API responses and
the browser shell use no-store, no-referrer, and a same-origin CSP. No raw HTML
preview or third-party scripts run on this origin. Drafts are not stored in D1
or logs. A scheduled handler cleans up expired sessions, states, and leases.

Every save rechecks repository permission, compares the reviewed SHA, and takes
a browser-local recovery copy. New branches are created only after explicit save.
Saving never replaces the active browser buffer or automatically retries an
uncertain write. A branch can remain created if the subsequent file write fails;
the user can select it on the next attempt.

## Tests

```sh
npm test
npm run check
npx wrangler deploy --dry-run
```

Browser suite, from the repository root with its existing Python environment:

```sh
venv/bin/python -m pytest prototypes/github-auth/tests/test_browser.py -q
```

The browser suite starts its own loopback demo server and makes no real GitHub
requests. Install Python `pytest` and `playwright` plus Chromium if needed.
Service tests use Node's SQLite engine to exercise the actual migration and
Worker SQL, with an injected fake GitHub upstream. Wrangler local D1 migration
and a deployment dry run separately validate Cloudflare compatibility.

Verified for this prototype: 28 service tests and 11 Chromium browser tests pass;
local and staging D1 migrations apply; Worker bundles and deploys; Jekyll build
and consistency checks pass. Live GitHub sign-in, the authenticated return, and
repository listing have been verified. Real commits remain a user acceptance check.

The deployed Worker rejected `redirect: 'error'` on outbound requests. Requests
now use `redirect: 'manual'` and explicitly reject 3xx responses without following
them. A regression test covers this credential boundary. Callback failures expose
only allowlisted support codes, never upstream messages, tokens, or authorization codes.

## Intentional prototype limits

- One local draft, stored with a separate prototype localStorage key; no migration
  of production-editor IndexedDB documents. Recovery holds 10 pre-save copies.
- No Markdown rendering, media, or iframe preview. Full editor integration must
  isolate preview content before using authenticated APIs.
- Markdown files up to 200 KB. Empty repositories must first be initialized on
  GitHub. No pull, merge UI, repository creation, or automatic publication.
- Sessions expire after at most eight hours (or sooner if the OAuth token does).
  Refresh tokens are discarded; this prototype asks the user to sign in again.
  Server-side refresh/rotation belongs in the integration phase.
- Sign-out deletes this server session; it does not revoke the app's entire GitHub
  authorization or remove browser drafts. GitHub's Authorized OAuth Apps settings
  provide account-wide revocation.
- No per-IP abuse throttling or multi-tab local-draft ownership yet. Keep staging
  to invited testers; add rate limiting and storage coordination before rollout.
- Existing-file replacement always requires explicit review; it does not implement
  the full editor's three-way conflict choices.

References: [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[Workers assets](https://developers.cloudflare.com/workers/static-assets/),
[D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/).


## Integrated editor staging

Development branch: `codex/editor-github-login`. The actual editor is now served
at https://storykit-auth-prototype.ron-f9a.workers.dev/editor/ alongside the small
prototype. Production uses a separate Worker at https://storykit-editor.ron-f9a.workers.dev/editor/. See [production deployment and recovery](../../docs/editor-central.md).

`node tools/build-editor.mjs` creates an allowlisted static asset directory;
never configure Workers assets to serve the repository root. Staging configuration
uses this build command and `.editor-assets`. Apply `0002_editor_return.sql`
before deploying: it retains the allowlisted editor return path in OAuth state.
The OAuth App callback URL and existing secrets are unchanged.

The editor no longer reads or sends the preview tool's legacy PAT. Public reads
remain anonymous; signed-in reads and writes go through constrained Worker
endpoints. IndexedDB records, revision history, and document bindings retain their
existing format. Drafts are saved before OAuth navigation, including the latest
buffer before the normal autosave debounce fires. Private bookmarklet opens are
resumed after login. Original branch/path and conflict SHA are preserved.

Rendered documents use an opaque sandbox origin. A frame-bound message channel
shares only validated geometry and scroll positions, preserving split-view scroll
sync without granting preview scripts access to editor storage or authentication.

Validation includes the full editor browser unit suite, service tests, and an
integrated browser test covering private bookmarklet open → login → destination
prefill → edit → persisted reload → save → sign-out. Live staging session discovery
and writable repository listing have also been checked. Saves in the automated
suite target the fake GitHub service. The M5 and keyboard end-to-end harnesses now use the authenticated service API. Safari/Firefox remain additional compatibility checks.

Staging still limits Markdown writes to 200 KB and uses eight-hour sessions.
Do not deploy the editor source alone to a static-only host expecting login to
work: `/api/` must be served on the same origin by the Worker. Existing browser
storage is origin-specific, so a different production address needs an explicit
export/import path for returning authors.
