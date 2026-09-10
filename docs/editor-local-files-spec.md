> Repository migration (2026-09-10): editor source, service, and tests now live in `rsnyder/storykit-editor`. Earlier source-location and standalone-preview references below are historical. See the root README for current build and test instructions.

# StoryKit editor: local story files specification

**Status:** v0.3 — image, data, and text support; staging validation in progress  
**Date:** September 7, 2026  
**Companion:** [Implementation and test plan](editor-local-files-plan.md)  
**Context:** [Publishing vision, content packages](publishing-platform-vision.md#8-content-packages-and-durable-records)

## 1. Outcome and release boundary

An author can add an image, data file, or text file from their computer, reference it in Markdown, preview it in the central editor, close and reopen the browser, export the complete story, and explicitly save the Markdown and managed files together to GitHub. Another browser can reopen that saved story with its files. No publishing-platform enrollment, staging repository, review system, or hosted-preview service is required.

This release introduces a **story workspace**: one Markdown document, its managed files, and the metadata necessary to save and recover them consistently. It does not add a live connection to the author’s filesystem. The editor copies bytes on import; later changes to the original require an explicit replacement.

“MUST” requirements below define release acceptance. Proposed numerical limits become final after M0 measures the complete browser/Worker/GitHub path. Milestones are described in the companion plan; they are implementation order, not independent declarations of feature completion.

### Included and deferred

| Included in this release | Deferred |
| --- | --- |
| JPEG, PNG, static WebP, JSON, GeoJSON, CSV, TSV, and TXT managed files | Animated images, SVG/HTML, PDF, audio/video, arbitrary attachments |
| Ordinary Markdown images and file links, image viewer, map GeoJSON layers | Local resources in compare, network, IIIF, and other viewer inputs |
| Add/insert/replace/remove, file list, missing-file diagnostics | Bulk asset library, shared-asset editing, arbitrary folder management |
| Browser persistence and asset-aware revision restore | Filesystem watching, background cloud autosave, real-time coauthoring |
| ZIP story-package export/import | Bundling all external resources, packaging the entire theme/runtime |
| Consistent multi-file GitHub save/pull through existing login | Publishing workflow, PR management, Jekyll builds as an editor service |

Existing external URLs and repository references continue to work. Unsupported local file types receive a specific explanation and leave the document untouched. Later file types should extend validation and resource adapters without replacing workspace/revision/sync contracts.

## 2. Current implementation and integration constraints

| Area | Current behavior and required extension |
| --- | --- |
| [dnd.js](../editor/dnd.js) | Local file drops show an upload-through-GitHub notice. Add ingestion and an accessible file picker while preserving URL grammars. |
| [store.js](../editor/store.js) | IndexedDB version 1 stores documents, text revisions, and caches. Add binary versions, workspace manifests, operations, and migration. |
| [context.js](../editor/context.js), [skrender.js](../assets/js/skrender.js) | Text `resolveFile` and URL rewriting are repository-aware. Add a separate binary resource contract; do not change text callers into binary consumers. |
| [preview.js](../editor/preview.js) | Preview is an opaque sandbox with frame/generation-validated messaging. Keep that boundary. |
| [image include](../_includes/embed/image.html), [image viewer](../assets/components/image.html), [media-url include](../_includes/media-url.html) | Paths become URLs and iframe query parameters; runtime can rewrite image URLs through a remote transformation service. Local-resource mode must bypass those remote rewrites. |
| [sync.js](../editor/sync.js), [github.js](../editor/github.js) | Sync commits one Markdown file and uses a file SHA conflict baseline. Add package snapshots and branch/tree baselines without losing existing snapshot-before-replacement behavior. |
| [doclist.js](../editor/doclist.js) | Export/import is Markdown-oriented; sync status is timestamp-based. Add package actions and content/manifest-based status. |
| [Worker](../prototypes/github-auth/src/worker.js) | Existing authenticated service accepts Markdown up to 200,000 bytes. Add constrained binary-read and package-save routes; retain current credential protections. |

Earlier editor documents describe contracts as frozen for their original milestones. This specification proposes explicit additive evolution of those contracts. Implementation must update affected tests and documentation, rather than preserve obsolete single-file assumptions in a second hidden workflow.

## 3. User-facing requirements

### LF-01 — Add and insert

**Add files** opens a multiple-file picker. Dropping supported files in the editor or pasting an actual supported clipboard image uses the same ingestion pipeline. A URL paste continues to use the existing URL workflow; do not silently download remote images into the workspace.

Validate a batch before applying it. Report invalid files individually and let the author add the valid subset; accepting the subset is explicit. Hash and persist accepted bytes before inserting references or reporting success. If persistence fails, keep source unchanged and explain recovery. File import works while signed out.

Dropping/pasting images onto the document inserts a StoryKit image tag by default, with a nearby option to use an ordinary Markdown image. Adding via the file panel stores the file without inserting it until **Insert** is selected. Preserve the insertion location across asynchronous validation; if its document closed or changed incompatibly, retain the file and offer insertion in the panel instead of inserting into another document.

Offer caption/attribution/alternative-text editing where supported by the selected representation. Never invent descriptive text or rights statements. Missing accessible descriptions receive diagnostics; supporting local files does not waive existing image accessibility expectations.

### LF-02 — Story files panel

Each file shows an image thumbnail when applicable, display name, portable path, size, recognized uses, and state: **Saved in this browser**, **Saved to GitHub**, **Changed locally**, **Missing**, or **Conflict**. Overall sync reflects both source and managed files.

Actions are Add, Insert, Replace, Remove from workspace, Download file, and Export story package. Provide keyboard access, focus restoration, visible upload/save progress, and accessible announcements. Do not require drag-and-drop.

Same-name imports offer **Use existing** only when bytes match, **Replace** with explicit acknowledgement, or a suggested unique filename. Replacement preserves references at the same path but creates a new byte version. A new file receives a new asset ID. Titles never rename asset paths automatically.

Removing a file still used in recognized references is blocked until those references are removed or changed. Removal from the workspace does not automatically delete an already committed repository file in this release: leave it in GitHub and report this clearly. Repository-wide reference analysis and remote asset cleanup are deferred. This prevents one story from silently breaking another story that reused its image. Local historical references retain their bytes until the associated revisions are pruned.

### LF-03 — Typed paths and reference scope

Scan literal Markdown image and link destinations (inline and reference-style), literal `geojson` layers on `embed/map.html` (including `|`-separated layers and `~` labels), literal `src` parameters on `embed/image.html`, and literal front-matter `image.path` values (including the `image: filename` shorthand). Cover paths use YAML syntax offsets; preserve unrelated fields, comments and alternative text. YAML aliases, block scalars and dynamic cover expressions are not automatically tracked. Respect existing `media_subpath`, `url`, `baseurl`, and repository path semantics. Do not parse Markdown or Liquid by global search/replace.

Classify references as managed-local, repository, external, missing, or unresolved/dynamic. A missing supported image reference offers **Locate file**, which binds imported bytes to the intended canonical path after validation. A dynamic Liquid expression or unsupported viewer reference is marked **Not checked**, not falsely reported as valid or missing. Raw HTML, CSS URLs, complex Liquid expressions, and other viewer resource parameters are outside automatic tracking in this release.

An unknown remote result caused by offline/auth/rate-limit errors is **Not verified**, not “missing.” Block package save when a recognized required managed file is missing. Unmanaged/dynamic references retain existing Markdown behavior with diagnostics; do not claim the package is self-contained when they cannot be verified.

### LF-04 — Save, pull, and export

Explicit **Save to GitHub** shows repository, branch, Markdown path, and files to add/change. It saves a consistent package snapshot. Adding files and signing in never trigger upload. Saving to a production branch can trigger that repository’s existing deployment exactly as today; the editor does not describe a GitHub save as inherently private or unpublished.

Pull/open restores a package at one commit, not a mix of branch versions. Preserve local text and byte versions before replacing anything. Package export/import works without an account. Markdown-only export remains available and explains when it omits managed assets.

## 4. Content and persistence model

### LF-05 — Identity and records

Proposed persisted records:

| Record | Required data |
| --- | --- |
| Document extension | `workspaceId`, `workspaceVersion`, existing text/path/binding, current `manifestHash` |
| Asset entry | `assetId`, repository-relative `path`, original/display filename, MIME, size, SHA-256 content hash, dimensions, descriptive metadata |
| Asset bytes | Immutable Blob keyed by SHA-256; stored separately from source/metadata |
| Package revision | Text snapshot, manifest snapshot, source path, workspace ID, reason/time; hashes reference immutable bytes |
| Sync baseline | Destination, commit OID, entry-point blob OID, manifest blob OID, managed path/blob map, last saved package digest |
| Save operation | Operation ID, account/destination, immutable snapshot digest, expected head, state, eventual commit OID |

Asset IDs, Git blob OIDs, and SHA-256 content hashes have different meanings and must not be interchanged. Hash a canonical, versioned package description to derive the package digest; timestamps and remote sync bookkeeping are excluded. Replacing only an image changes that digest.

Upgrade IndexedDB additively. Existing drafts/revisions/bindings must survive without network access. Existing documents initially have an empty managed-file manifest. Adding files does not overwrite the recorded remote Markdown SHA. Legacy text-only revisions explicitly have no managed asset snapshot; restoring one must explain that limitation and retain current bytes for recovery rather than inventing historical associations.

Validate/decode/hash outside an IndexedDB transaction, then commit bytes, manifest, and applicable document updates atomically. A failed transaction exposes no half-imported workspace. Quota errors leave the previous state usable. Serialize mutations per document across tabs with a version check/transaction; a BroadcastChannel can refresh UI but is not the concurrency authority.

Package capture for sync/export must include the latest editor buffer and the matching manifest at a single workspace version. If edits occur during capture, retry or capture at a defined version without mixing states. Retain immutable captured bytes while an operation runs. Edits during save remain dirty after the captured revision succeeds.

Before replacement, removal, pull, conflict adoption, or revision restore, create a forced package snapshot. Undo of source insertion can leave an unused file in the panel; removal of bytes is a separate action. Restoring a package revision restores source and asset associations together and becomes a new local change.

Garbage collection runs only on bytes unreachable from current workspaces, retained package revisions, or pending operations. Keep existing text revision limits initially; measure asset history growth and show storage usage. Never discard the only copy of a current file to meet a history budget. Handle blocked database upgrades by asking the user to reload old tabs without deleting data.

### LF-06 — Portable paths and manifest

Use StoryKit’s existing front-matter convention as the asset-location authority: `media_subpath: /assets/posts/<post-id>`, where `<post-id>` is the post filename’s slug after removing its leading `YYYY-MM-DD-` and Markdown extension. For `_posts/2026-01-10-monument-valley.md`, the default is `/assets/posts/monument-valley`. Do not derive an existing post’s directory from its display title, a permalink override, or the editor’s workspace UUID.

Managed files use paths relative to this media directory in source and full repository-relative paths in the package manifest. Strip the leading `/` only when mapping the media directory to a Git repository path. Do not store a host, deployment baseurl, or date prefix in the conventional media directory.

For a new post without `media_subpath`, propose the directory from its initial filename and persist it when the author first adds a file. If no filename exists yet, propose a stable post slug through the existing document naming flow. An existing explicit `media_subpath` takes precedence over the convention: preserve it, including older local directories such as `/assets/img`. The current post template uses that older value; update the editor’s new-post initialization in this feature so it proposes the conventional per-post directory without changing existing drafts or shared templates silently.

Package writes may add/change validated managed files only within the selected local `media_subpath` under `assets/`, scoped to the explicit package paths and their destination baselines. An existing shared directory does not make all its contents owned by this story. **Locate file** outside the selected media directory offers an explicit import into that directory and a supported reference update; it does not silently broaden write scope.

An external-URL `media_subpath` remains valid for existing remote content but is not a GitHub upload destination. In this initial release, explain that local managed-file insertion requires a local media directory. Do not change the external prefix automatically. Any author-requested change must account for existing references; unsupported/ambiguous migrations need manual source edits before the new destination can be adopted.

Keep workspace identity separate from post ID and media location. A title or date edit does not relocate assets. Renaming the filename’s slug also preserves an existing `media_subpath`; moving assets is a separate, explicit operation and automatic remote relocation is deferred. Duplicate post slugs or shared media directories require destination/path collision checks, not automatic overwrite or a switch to UUID-based directories.

Generate safe unique names, preserving the original display name in metadata. Normalize separators and Unicode consistently. Reject traversal, absolute filesystem paths, encoded traversal, NUL/control characters, case-fold collisions, symlinks, and paths outside the allowlist. An explicit overwrite always compares the destination’s recorded blob baseline; an imported manifest is not permission to overwrite files.

Persist an optional rendering-independent manifest at `_data/storykit_workspaces/<workspaceId>.json`. Add `storykit_workspace: <workspaceId>` to front matter when enabling managed files, preserving other front matter and formatting as far as practical. The ID allows a fresh browser to locate the manifest. The manifest records `schemaVersion`, workspace ID, entry path, and owned file metadata/hashes. It contains no credentials, computer paths, session IDs, local history, or remote baseline state.

Jekyll needs neither that front matter key nor the manifest to render the story. Paths remain ordinary StoryKit paths. Exported content still works if the metadata is ignored. The manifest is versioned in the same commit as source and assets; verify that it is not emitted as an unintended public file by the site build.

For example, a post with the following front matter and references owns `assets/posts/monument-valley/photo.jpg` in GitHub:

```markdown
---
media_subpath: /assets/posts/monument-valley
---

![Description](photo.jpg)

{% include embed/image.html src="photo.jpg" %}
```

Both forms resolve through `media_subpath`; the delivery layer applies `site.url`, `site.baseurl`, and applicable CDN behavior. The local preview resolves the same relative reference to browser-stored bytes before those delivery transformations. The editor must not insert the whole media directory into a relative `src` and cause it to be prefixed twice. M0 verifies these exact forms against actual Jekyll output, including existing non-default media paths and CDN settings. Compatibility fixes necessary to honor the established convention are in scope; a new asset-directory convention is not.

### LF-07 — Initial resource limits

| Limit | Proposed default |
| --- | --- |
| Markdown bytes | Existing 200,000-byte limit |
| Imported file bytes | 5 MiB per file |
| Current managed files | 50 files and 8 MiB total decoded file bytes per workspace |
| Decoded dimensions | 4 megapixels per image; reject invalid/animated images |
| Serialized package-save request | 12 MiB maximum; enforce decoded limits independently |
| ZIP import | 10 MiB archive; 9 MiB total expanded bytes; at most 64 entries |
| Manifest | 256 KiB maximum; bounded strings and schema |

These are StoryKit product limits, not claims about maximum GitHub or Cloudflare capabilities. The manifest/text/metadata must fit within archive/request bounds too. Validate actual signatures, supported decoding, dimensions, bytes, and paths in client and server. Do not silently resize or recompress originals. Thumbnails are disposable derivatives and do not replace originals. Broader formats and larger budgets require measured follow-up work.

### LF-07a — Data and text formats

Support `.json` (`application/json`), `.geojson` (`application/geo+json`), `.csv` (`text/csv`), `.tsv` (`text/tab-separated-values`), and `.txt` (`text/plain`). Derive type from the allowlisted extension rather than the picker-supplied MIME. Preserve original bytes, including UTF-8 BOMs and line endings. All formats share the existing count, byte, archive, and request budgets; only images have dimensions. Empty CSV, TSV, and TXT files are permitted.

Decode text with fatal UTF-8 validation and reject binary control characters (except tab, CR, and LF). Parse JSON; reject invalid/non-finite numbers, nesting deeper than 64, and more than 500,000 JSON values. GeoJSON additionally validates geometry types, finite coordinate positions, line/ring structure, features, and feature collections. CSV and TSV are stored as text without imposing a header, column count, or dialect. No script or HTML execution is added for data files.

Inserting GeoJSON produces a portable `embed/map.html geojson="filename.geojson"` tag. Other data/text insertions produce ordinary Markdown file links with literal repository-root paths passed through Jekyll’s `relative_url` filter; this preserves root and project-site portability. This exact literal filter form is tracked, while dynamic Liquid links remain Not checked. Local links download the exact bytes in preview. JSON containing GeoJSON may be used explicitly in a map's `geojson` parameter. Invalid map data displays a local error. The map fits GeoJSON bounds when no explicit center or zoom is supplied, in preview and the published runtime.

Only the explicit GeoJSON layer parameters receive local map bytes. Preserve external layers and layer labels. No automatic resolution is added for URLs inside data files or other component parameters. Editing, replacement, copy, history, ZIP, and GitHub operations reuse the existing package contract. Data entries omit width/height; manifest schema 1 remains additive, and service capability `localData: 1` gates data saves. Older clients reject unknown MIME entries: rollback must use a client that understands these files, preserving read/export recovery.

## 5. Local preview resource contract

### LF-08 — Resolve locally without exposing the editor

Preview order for a supported managed path is: bytes for the current package revision, then verified bytes for its pinned repository baseline. If the manifest expects a local replacement whose bytes are missing, show an error; never fall back to older remote bytes under the same filename.

The renderer must retain a mapping from recognized source references to canonical paths before production URL/CDN rewriting. Do not infer ownership from an arbitrary URL that happens to end in a matching filename. Asset lookup augments existing text `resolveFile`; it does not replace it.

Proposed internal contract:

```ts
type PreviewAsset = {
  resourceId: string; path: string; contentHash: string;
  mime: string; size: number; bytes: Blob;
};
type PreviewResources = {
  generation: number;
  assets: PreviewAsset[]; // only resources referenced by this render
};
```

Send only the bytes needed for the current render through a constrained bridge. Ordinary images can receive temporary URLs created within the preview context. A supported nested image or map viewer receives its assigned bytes through a viewer-specific handshake and creates its own object URL in its own context. Gate viewer readiness so it does not fetch the unresolved local path first. Map viewers are allowlisted independently and can receive multiple explicitly assigned resource IDs. Downloads add `allow-downloads` to the outer opaque sandbox, without `allow-same-origin`. Extend image-viewer initialization with an explicit editor-resource mode; published `src`/manifest behavior remains supported.

Blob URLs have origin/storage-partition constraints and must be released when no longer needed. A URL created in the editor cannot be assumed readable by every nested viewer. This is why the resource consumer creates its own temporary URL after receiving bytes. [MDN blob URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob).

The central editor MUST retain the opaque sandbox. No `allow-same-origin` shortcut, editor service worker exposing authenticated resources, unauthenticated upload service, or remote transformation of local image bytes is permitted. Exempt local-resource mode from Cloudinary/other network URL rewriting. A network assertion must prove no local image content, temporary URL, or local path is sent to those services.

Bind messages to expected window, render generation, request ID, and registered resource/viewer. Verify known viewer origins when available; an opaque origin of `null` alone is not authentication. The top editor accepts messages only from its current preview window; it does not fulfill arbitrary nested-frame resource requests. The preview distributes only resources already assigned to a registered viewer. Reject wrong document, stale generation, unknown resource, malformed/oversized message, and foreign-frame requests. No token, filesystem, GitHub request, or arbitrary URL operation exists in this bridge.

Viewer bytes are intentionally visible to the story preview using them; isolation protects other documents and editor authority, not secrecy from the rendered story itself. Tear down ports/listeners and revoke object URLs on frame destruction, document switch, and replacement, after consumers release them. Preserve zoom/action links, scroll sync, theme handling, and flat/two-column behavior.

Full offline rendering is not promised: theme/runtime libraries may still need the network. With runtime fixtures cached/available, local image bytes must render without fetching them remotely.

## 6. GitHub package synchronization

### LF-09 — Constrained service API

Add routes to the existing Worker; do not expose a general GitHub proxy or client-supplied GraphQL:

| Proposed route | Contract |
| --- | --- |
| `GET /api/github/workspace` | Authorized read of entry point and schema-validated manifest at a resolved commit OID; returns bounded metadata and path/blob map. |
| `GET /api/github/asset` | Bounded read of an allowlisted regular managed file at an explicit commit/path; returns bytes, MIME, and blob identity, with private responses `no-store`. |
| `POST /api/github/workspace/save` | Operation ID, destination, expected head, package digest, source/manifest, changed images, expected old blob OIDs. Returns exact commit and saved path/blob map. |
| `GET /api/github/workspace/operations/<id>` | Same-account authorized lookup/reconciliation of an uncertain save; never returns credentials or unrelated operations. |

Carry bytes as base64 additions for the initial bounded request design. Enforce streaming request limits before unbounded parsing, then independently validate decoded data. Do not log bodies or retain content in D1. D1 may hold short-lived operation IDs, digests, expected/returned OIDs, and status. Check CSRF, origin, session, repository push permission, path policy, manifest consistency, and branch protection for every mutation.

Generate the manifest server-side from validated fields. Accept one entry-point Markdown file using the existing safe path policy, the exact workspace manifest path, and managed file paths only. Reject executable/symlink modes, `.github`, arbitrary `_data`, includes, plugins, configuration, or workflow edits. Preserve all unrelated repository files. The service must verify membership/ownership rules from the baseline, not trust a list of paths in an uploaded archive.

### LF-10 — Atomic save and conflict behavior

Use GitHub’s `createCommitOnBranch` mutation as the preferred package commit primitive: it supports file changes and an `expectedHeadOid` precondition. The Worker constructs the fixed mutation. GitHub’s file additions accept base64 binary content. M0 verifies the actual OAuth, branch-protection, and payload-limit behavior before this becomes the implementation contract. [Commit mutation](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch), [Git file inputs](https://docs.github.com/en/graphql/reference/git#fileaddition).

Save algorithm:

1. Persist/capture immutable package P and its baseline before networking; allocate an operation ID.
2. Recheck destination and current head H. Compare relevant source, manifest, and managed file blob OIDs against the baseline. Preserve the existing remote Markdown SHA when upgrading a legacy binding.
3. If only unrelated repository files changed, prepare on H while preserving those changes. If package paths changed, enter explicit conflict handling. Snapshot local source and assets before adopting any remote version.
4. Validate the complete resulting package; include only changed source/manifest/images in one mutation with expected head H. Preserve unchanged files by leaving them out.
5. A head change during the mutation aborts the save. Reconcile again with bounded retries for unrelated changes; conflicting changes require the author’s decision. Never force-update a branch.
6. On success, advance the baseline to saved P/commit only. Compare the current workspace with P; newer local edits remain unsaved.

For a new branch, use the explicitly chosen source baseline and create the branch through existing branch operations, then commit the complete package with the head precondition. Failure may leave an empty author branch pointing at its source, but never a partially saved story. Empty repositories still need explicit initialization. Never recreate a disappeared bound branch without user intent.

Conflict choices are keep local, use remote, or keep both at different asset paths, plus cancel. Source text retains the existing conflict UI as appropriate; binary files never receive a text merge. “Keep local” uses a newly acknowledged remote baseline for that path, not a blanket force push. Manifest merge must reconcile path/ID changes consistently with the chosen bytes. If two stories claim the same owned path, block implicit takeover.

REST reference updates with `force: false` are not an exact expected-head compare-and-swap API. Do not silently substitute a read-then-update sequence if the chosen primitive is unavailable; record and test an alternative concurrency design first. [Git reference update](https://docs.github.com/en/rest/git/refs#update-a-reference).

### LF-11 — Uncertain results and remote recovery

An operation ID is application-level retry identity; a GraphQL `clientMutationId` is not assumed to make mutations idempotent. Persist the attempt metadata before sending. Include an operation marker/digest in the commit message and reconcile the returned commit or bounded branch history after a timeout. Verify its package paths/hashes before declaring success. Account/destination/payload must match for reuse of an operation ID.

If the matching commit is an ancestor of a later commit, distinguish “our save succeeded” from “remote has changed since.” Do not mark later remote state as locally synchronized. If history cannot establish the outcome, preserve the uncertain state and offer comparison rather than automatically producing another commit. A no-change save creates no empty commit.

A fresh browser reads source and its workspace manifest at one commit, validates paths/schema, and downloads bounded managed assets through the authenticated service when necessary. Only mark a package available locally when its required bytes are present. A failed multi-file pull retains the previous active workspace; partial downloads may be cached but are not adopted. Never put private credentials in image URLs or bypass the service through an anonymous CDN.

For older stories without a manifest, retain ordinary open behavior. Supported references can be explicitly imported into managed state after loading their bytes; do not claim ownership of arbitrary shared repository assets automatically. Unknown manifest versions leave Markdown readable/exportable but disable destructive package sync until supported.

## 7. Package portability

### LF-12 — ZIP format and import safety

Export `<title>.storykit.zip` with the entry-point file at its portable repository path, owned files at their repository paths, and the versioned `_data/storykit_workspaces/<id>.json` manifest. Preserve UTF-8 source and original file bytes. Export current content only; historical revisions and login/repository credentials are excluded. Source references remain unchanged.

The export UI distinguishes owned files from external/repository references left outside the package. The archive is portable source content, not a self-contained offline website. It should build when placed into a compatible StoryKit site with its remaining referenced resources available.

Import validates paths, schema, hashes, types, entry counts, total expanded bytes, and duplicate/case-colliding entries before creating a workspace. Enforce bounds while decompressing; reject archive traversal, symlinks, nested archives, and unsupported payloads. An archive manifest cannot authorize API writes. Abort cleanly without exposing a partial document if validation/persistence fails.

Import creates an unbound local document by default and preserves its `media_subpath`. If that workspace ID already exists, offer open-existing or import-a-copy. Copying allocates a new workspace ID while proposing a distinct post slug and conventional media directory. After the author accepts that destination, update front matter and manifest paths; simple media-relative filenames remain unchanged. Rewrite explicit paths only through parsed supported references, and block ambiguous changes with an explanation. Title, source-path, and asset-name collisions must not overwrite another local document. Later GitHub binding validates remote collisions separately. An internal identity change alone must never relocate files.

## 8. Release invariants and completion

The following MUST hold across reload, conflict handling, error, export, and account switch:

1. A “saved” package always identifies consistent source and byte versions.
2. Local addition/preview/export sends no local asset bytes to a server.
3. The preview cannot reach editor authentication/storage or another workspace’s files.
4. A failed import, pull, or save preserves a recoverable prior workspace.
5. No temporary URL, credential, filesystem path, or browser-only asset ID is required to render committed/exported content.
6. Image-only changes mark the document dirty; saves never clear newer edits.
7. Existing Markdown-only users need no workspace migration action and retain their existing workflow.
8. The complete authoring → local preview → export/reimport → GitHub save → fresh-browser open → real Jekyll render path passes before publishing-platform development depends on this feature.

The test matrix, milestone gates, rollout, and implementation boundaries are in the [plan](editor-local-files-plan.md). This specification defines proposed work; none of these new capabilities are represented as implemented.
