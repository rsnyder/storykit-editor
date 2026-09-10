> Repository migration (2026-09-10): editor source, service, and tests now live in `rsnyder/storykit-editor`. Earlier source-location and standalone-preview references below are historical. See the root README for current build and test instructions.

# Central editor

Production runs at **https://storykit-editor.ron-f9a.workers.dev/editor/**.
The Cloudflare Worker serves the editor and its same-origin GitHub authentication
and API service. Authors can edit and export Markdown without signing in. Sync
uses GitHub login and a searchable list of writable repositories; no PAT is
entered or retained by the editor.

## Source and deployment

The source of truth remains `rsnyder/storykit-starter`: `editor/`, shared runtime
assets, and `prototypes/github-auth/`. The service directory keeps its original
prototype name but also contains the integrated production deployment.

From `prototypes/github-auth/`:

```
npm ci
npm test
npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
npx wrangler deploy --config wrangler.production.jsonc
```

The production config contains public identifiers only. `GITHUB_CLIENT_SECRET`
and `TOKEN_ENCRYPTION_KEY` are encrypted Worker secrets. The production GitHub
OAuth App callback is
`https://storykit-editor.ron-f9a.workers.dev/api/auth/callback`.
Staging remains independently available at
`https://storykit-auth-prototype.ron-f9a.workers.dev/editor/`, with its own OAuth
App, database, and secrets. Never serve the repository root as Worker assets;
the build copies an allowlist into `.editor-assets`.

The editor source alone cannot provide login on a static host. Both `/editor/`
and `/api/` must be served on the Worker origin. Root links preserve bookmarklet
query parameters when redirecting to `/editor/`.

## Documents and preview

IndexedDB drafts and revision history remain browser-local. Signing in uploads
nothing. Signing out removes the server session without deleting drafts.
Document bindings retain owner, repository, branch, file path, and the original
GitHub SHA. Bookmarklet opens supply the default sync destination, including
private files resumed after login. A different account must choose a writable
destination explicitly if it cannot write to the original repository.

Bound documents obtain layouts, includes, configuration, and media from their
repository. Framework viewer pages and scripts resolve to the canonical
`https://rsnyder.github.io/storykit-starter` site. Publish changes to shared
runtime assets there as part of a release.

Preview HTML runs in an opaque sandbox so scripts cannot read editor storage or
use its authenticated APIs. Frame-bound messages carry validated scroll geometry
and viewer actions. Theme storage is disposable and local to the preview frame.

## Previous address and draft recovery

`https://rsnyder.github.io/storykit-editor/` offers a transition page linking to
production and a recovery editor at `./legacy/`. The deploy-only
`rsnyder/storykit-editor` repository pins that recovery editor to
`storykit-starter@1d9256c18a13abc7419a40669ba4d4286d389c7e`.
It no longer deploys the latest authenticated editor to static Pages.

The recovery editor shares the old GitHub Pages origin and IndexedDB database,
so returning authors can export their existing drafts as Markdown, then import
those files into the new editor. Opening the transition page does not erase or
move any draft. Bookmarklet `open`, `repo`, and `branch` parameters are preserved
on the link to production. Automatic migration across origins is not provided.

## Operating limits

Sessions last at most eight hours; expired or revoked access requires another
login. Markdown writes are limited to 200 KB. GitHub organization policy can
require approval of the OAuth App. The service constrains API operations to
repository discovery, branch operations, and Markdown reads/writes; CSRF and
expected-SHA checks protect mutations. Roll back a Worker deployment using
Cloudflare deployment history if needed; keep the database and secrets intact.

## Local story packages

See [implementation evidence and rollout](editor-local-files-progress.md) and
[author help](../editor/help.html#story-files). Apply migration
`0003_workspace_operations.sql` before enabling package saves. The package API
advertises `workspace: 1`; image consumers use local-image protocol 1.
Deploy the canonical image viewer and its resource helper before production
client promotion. Browser-local authoring, package export and history do not
require sign-in. The Worker retains operation identities and Git baselines,
never draft or image bytes, in its database.

The supported package total is 8 MiB, with 5 MiB/4 MP per image. Rollback must
retain IndexedDB v2 and the package reader/exporter; a v1-only client cannot
safely act as the rollback build. Production rollout and the independent author
pilot are separate from the staging proof recorded above.
