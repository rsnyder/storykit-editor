> Repository migration (2026-09-10): editor source, service, and tests now live in `rsnyder/storykit-editor`. Earlier source-location and standalone-preview references below are historical. See the root README for current build and test instructions.

# GitHub sign-in and repository selection

Status: integrated; production configuration and rollout documented in [Central editor](editor-central.md).
Date: 2026-09-06.

Prototype implementation: [GitHub auth prototype](../prototypes/github-auth/README.md)
provides the standalone local demo, integrated editor, and separate Cloudflare staging and production configurations. See the prototype README for validation details.

## Product behavior

The editor opens directly into local authoring. Creating, editing, autosaving,
restoring revisions, importing, and exporting do not require an account.
Preview retains its existing network requirements for external assets. GitHub
is an optional destination for a document, not the owner of the local workspace.

First sync:

1. The author selects **Save to GitHub**.
2. The panel explains: “Keep writing in this browser. Sign in to save a copy
   to a GitHub repository.” It offers **Sign in with GitHub**.
3. Persist the latest buffer before navigating to GitHub. If saving locally
   fails, keep the editor open and offer export rather than navigate away.
4. GitHub handles account selection and consent, then returns the author to
   the same document and sync panel. Cancellation returns to local editing.
5. Show “Signed in as @username” and a searchable **Repository** picklist.
   Each result shows owner/name and public/private visibility. If this document
   already has a GitHub binding, preselect its repository after verifying write
   access. Repository ownership does not need to match the signed-in username.
6. Selecting a repository loads branches and proposes a file path from the
   existing document path or a dated title slug. Use the repository's actual
   default branch for an unbound document; preserve a bound document's branch
   and exact path. Never silently replace a missing bound branch with `main`
   or the repository default. Keep branch and file location
   visible in the final save summary; allow choosing or creating a branch.
7. **Save to GitHub** explicitly commits the document. Signing in or picking a
   repository alone never writes a file or creates a branch. If a file exists,
   use the existing conflict decision and snapshot-before-replacement behavior.
8. Report the repository, branch, and path saved, with a link to the file.
   Returning authors go directly to this destination summary while signed in.

“Saved in this browser” and “Saved to GitHub” remain distinct statuses.
Signing in never uploads all local drafts or automatically pulls remote content.
Signing out preserves documents, revisions, and bindings and disables authenticated
sync. Explain that sign-out does not erase local copies on a shared computer.

## Files opened with “Edit in StoryKit”

Preserve the existing bookmarklet contract: `?open=<GitHub file URL>` and
`?repo=<owner>/<repo>&branch=<branch>&open=<file path>`. The current editor
handles these in `editor/app.js`; `openFromGitHub` in `editor/sync.js` stores
the file path on the document and `{ owner, repo, branch, sha }` in its GitHub
binding. Reopening the same file reuses its local document and preserves edits.
The authentication replacement must retain this behavior.

The binding belongs to the document, not the login session. Persist it with the
draft through OAuth navigation, cancellation, reload, sign-out, and account
switching. After sign-in, validate the original repository and branch, then show
them and the exact file path as the default sync destination. Keep a visible
option to choose another repository or branch. Changing the story title must
not rename the original file implicitly.

If the original repository is unavailable or not writable, retain its source
reference and explain that this account cannot save there. Offer another
destination or local export without silently choosing a different repository.
If the original branch no longer exists, require an explicit destination choice.
An ambiguous URL containing a branch with slashes must be resolved against
GitHub refs or supplied with an explicit branch; do not guess a write target.

Retain the SHA captured when the document was loaded or last synced. Before
saving to that same destination, compare it with the current remote SHA and
invoke the conflict flow if they differ. Authentication or destination
prefilling must not replace the baseline SHA with the current remote version.
Saving elsewhere establishes a new binding only after the save succeeds.

Public file opening should continue to work without sign-in when GitHub permits
anonymous reads. A private file can require sign-in to load; preserve the pending
file reference across that round trip and complete only that explicit open
request. Neither case automatically commits content. The integrated `/editor/` staging build now implements bookmarklet import and
per-document bindings. Its browser test covers a private-file open through login,
destination defaults, editing, reload, save, and sign-out.

## Authentication choice

Recommend a **GitHub OAuth App** with the authorization-code web flow, state
validation, and PKCE (S256). This best matches the desired single sign-in followed
by repositories the user can write to, including collaborator repositories.

GitHub recommends GitHub Apps in general for finer permissions and repository
selection. A GitHub App remains an alternative if selected-repository grants
are more important than onboarding simplicity: the app must be installed with
access to the target repository, which can require the repository owner's or
organization administrator's involvement. Neither option bypasses organization
policies, SSO requirements, or branch protection.

Proposed scope: `repo`, preserving the current editor's public and private
repository support. This is broad permission, not permission limited to the
repository selected in StoryKit. Explain that accurately in consent help.
If the product becomes public-repository-only, use `public_repo` instead.
Do not request email, workflow, repository deletion, or organization management
scopes. Prefer expiring OAuth tokens with server-managed refresh.

References: [OAuth authorization flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[GitHub Apps and OAuth Apps](https://docs.github.com/en/apps/differences-between-github-apps-and-oauth-apps).

## Hosting and trust boundary

The editor remains a static browser application with IndexedDB as the local
document store. Add a small authentication and GitHub API service. It holds
the OAuth client secret, exchanges codes, manages sessions and refresh tokens,
and forwards only the GitHub operations the editor needs. It is not a draft
storage service; document content passes through it only for requested GitHub
operations and must not be logged or retained as application data.

Hosting decision approved 2026-09-06: **Cloudflare Workers**. Serve the static
editor using Workers Static Assets and `/api/` using Worker code on one dedicated
origin. Store encrypted credentials
server-side; give the browser an opaque Secure, HttpOnly, SameSite=Lax session
cookie. This avoids depending on third-party cookies between GitHub Pages and
an unrelated authentication-service domain. The production domain remains open.

One shared deployment serves all editor users; authors and repository owners
do not provision their own service. The Cloudflare account is controlled by the
StoryKit operator. Published story sites continue to use GitHub Pages.

| Cloudflare resource | Responsibility |
| --- | --- |
| Workers Static Assets | Editor HTML, JavaScript, CSS, and supporting static files |
| Worker API routes | OAuth callbacks, sessions, and constrained GitHub operations |
| Workers Secrets | OAuth client secret and credential-encryption key |
| D1 | Server sessions, expiring OAuth state, and encrypted access/refresh tokens |

Use separate staging and production Workers, databases, secrets, and OAuth
registrations. Keep draft content out of D1. Session records need expiry and
revocation; store a hash of the browser session identifier. Encrypt GitHub
credentials before persisting them, with encryption keys held separately in
Workers Secrets. Specify cleanup, key rotation, and concurrent token-refresh
handling during implementation. Configure static asset routing so `/api/*`
always reaches Worker code and never falls back to the editor HTML.

References: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/),
[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[D1](https://developers.cloudflare.com/d1/).

The current `rsnyder.github.io/storykit-editor/` shares its origin with other
Pages projects. A dedicated editor origin also separates it from those sites.
Changing origin requires an explicit draft migration/export path before cutover,
because IndexedDB cannot move automatically across origins. Keep the old editor
available during migration; do not replace it immediately with a redirect.

Preview isolation is part of this release. Current same-origin script-enabled
srcdoc previews can access the editor. HttpOnly cookies alone do not fix this:
preview scripts could still operate authenticated APIs through the parent.
Move rendered previews to a separate, unauthenticated origin or a tested opaque
sandbox. Use a constrained postMessage bridge for render delivery, scroll sync,
heading positions, diagnostics, and viewer actions. Validate sender window,
message shape, and render generation; validate exact origins when non-opaque.
Never accept GitHub/auth commands through this bridge. Private source supplied
to preview stays in browser messaging, not uploaded to a preview host.

API protections: exact callback and return-path allowlists, one-use expiring
state bound to the initiating browser, PKCE verification, session rotation after
login, Origin and CSRF validation on state-changing requests, credential-free
logs, and no-store responses for session/private content. Restrict proxy routes,
methods, and payloads rather than accept arbitrary upstream URLs. GitHub tokens
never enter localStorage, IndexedDB, rendered HTML, URLs, or messages to frames.

## Repository and branch picker

Load `/user/repos` with owner, collaborator, and organization-member affiliations.
Follow pagination through all pages; do not silently stop at 100 repositories.
Allow progressive results with a visible loading state and cancellation when the
panel closes or the account changes. Search owner/name; label partial results
until loading completes. Cache only within the authenticated account/session.

Offer entries where `permissions.push === true`, excluding archived and disabled
repositories. Recheck repository access when binding/saving. Repository write
permission does not guarantee permission to write every branch: explain protected
branch failures and allow choosing a permitted author branch. Do not silently
retry a failed save on another branch.

Empty/error states distinguish loading, no writable repositories, failed fetch,
expired login, and access restrictions. Include **Refresh repositories** and
**Missing a repository?** guidance covering invitations, account selection, and
organization approval/SSO. Do not assert a specific restriction without evidence.
Do not hide non-StoryKit repositories: compatibility guidance is separate from
write access. A newly selected empty repository needs an explicit initialization
path or actionable explanation; existing branch-creation code assumes a HEAD.

Branches also require pagination. Resolve existing branches directly when
appropriate, and support names containing `/` throughout API calls and pickers.

Reference: [List repositories for the authenticated user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user).

## Code boundaries

| Area | Proposed change |
| --- | --- |
| New `editor/auth.js` | Session state, sign-in navigation, sign-out, account identity; no GitHub credentials |
| New repository-picker module | Search, pagination, selected repository, accessible loading/error states |
| `editor/github.js` | Preserve existing file/branch method contracts behind service transport; add repository listing; replace PAT methods |
| `editor/app.js` | Replace token and owner/repo fields with account and picker UI; extract sync panel into its own module |
| `editor/sync.js` | Keep SHA/conflict behavior; serialize operations per document and preserve edits made during network requests |
| `editor/context.js` | Route private repository reads through session transport; keep public/CDN fallback and local cache behavior |
| `editor/preview.js`, `editor/scrollsync.js` | Replace direct cross-frame DOM access with constrained preview bridge |
| `editor/store.js` | Retain document/revision schema; scope authenticated caches and invalidate them on account change |
| New service directory | OAuth/session routes and explicit GitHub read/write endpoints, deployment configuration, operator setup |
| Specs/help/tests | Replace v1 PAT instructions for the new editor and document migration |

Suggested service endpoints: `/api/auth/start`, `/api/auth/callback`,
`GET /api/session`, `POST /api/auth/logout`, and explicit `/api/github/` routes
for repositories, branches, files, and branch creation. File endpoints preserve
SHA, ETag, and error semantics consumed by current sync code. Return identity
and expiry state from the session endpoint, never tokens. Logout invalidates
the server session; a separate disconnect operation can revoke GitHub access.
Do not automatically retry uncertain writes after reauthentication: fetch and
reconcile remote state first.

Persist pending sign-in intent as document ID and panel state, not source text
or credentials. Returning from OAuth restores the UI, but does not execute an
old commit automatically. On account change, clear account-specific repository
results and revalidate bindings before writing. Browser-local drafts intentionally
remain available on this browser regardless of the signed-in GitHub account.

The standalone `preview/index.html` has its own PAT workflow. This proposal
replaces authentication in the editor only. Do not silently delete its shared
legacy PAT key; stop reading it in the new editor and provide explicit removal
guidance. It is not possible to convert an existing PAT into OAuth consent.

## Delivery and acceptance

1. Finalize OAuth application type, scope, editor domain, and local-data migration
   plan. Configure the approved Cloudflare Workers deployment and register
   development and production OAuth apps.
2. Implement session service and preview isolation with mocked GitHub tests.
3. Integrate account UI, paginated repository/branch selection, and existing sync.
4. Test with real collaborator and organization accounts in staging; update help
   and central-editor publishing configuration before production cutover.

Required checks beyond the existing 486 browser unit tests and render/e2e suites:

- Local authoring/export works signed out, offline, and during service outages.
- Login success, cancellation, callback replay/state mismatch, expiry, refresh,
  logout, and account switching preserve drafts and pending document selection.
- Pagination includes more than 100 repositories/branches; read-only, archived,
  disabled, collaborator, and organization cases behave correctly.
- Saving handles new/existing paths, slash-containing branches, protected branches,
  revoked permissions, conflicts, concurrent edits, and uncertain network outcomes.
- Preview content cannot read parent storage or invoke authenticated service
  operations; tokens never appear in client storage, URLs, logs, or frame messages.
- Private preview resources still work through the new boundary, and scroll sync,
  interactive viewers, clipboard operations, and existing render goldens remain valid.
- Origin migration preserves recoverability of all local drafts and revisions.

Remaining design review decisions: accept OAuth's broad `repo` grant versus GitHub
App installation friction; select the production domain; decide whether private
repositories remain in scope. No running application behavior changes in this draft.
