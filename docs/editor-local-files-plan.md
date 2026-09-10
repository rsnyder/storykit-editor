> Repository migration (2026-09-10): editor source, service, and tests now live in `rsnyder/storykit-editor`. Earlier source-location and standalone-preview references below are historical. See the root README for current build and test instructions.

# StoryKit editor: local story files implementation and test plan

**Status:** Proposed v0.2  
**Date:** September 7, 2026  
**Requirements:** [Local story files specification](editor-local-files-spec.md) (LF-01–LF-12)

## 1. Delivery objective

Release local images as a usable, independent editor feature before implementing the publishing workflow. Completion means an author can add, preview, persist, recover, export/import, and save a story with owned files using the existing editor and an ordinary StoryKit repository.

Use sequential milestones with explicit exit evidence. Work may be divided among contributors after interfaces are agreed, but this plan does not require delegation or prescribe simultaneous edits to shared modules. Do not build a publishing service, review queue, staging preview collection, or new viewer family during this work.

## 2. M0 — Prove preview transport and package commits

**Requirements:** LF-06–LF-10. **Dependency:** none. **Deliverable:** executable technical fixtures and short decision records, before broad UI work.

### Preview proof

Construct a fixture with an opaque story preview and the existing image viewer at its actual distinct runtime origin. Send a small local image to its consumer, create the temporary resource URL there, and exercise image opening, zoom/action links, flat/two-column mode, and document switching. Include the real URL normalization and remote image transformation code paths.

Use the established `media_subpath: /assets/posts/<post-id>` convention, with post ID taken from the filename without its date prefix or extension. Prove that `![Description](photo.jpg)` and an image viewer with `src="photo.jpg"` resolve to the same managed bytes and production asset. Test root/project baseurls, an existing custom local prefix (including the current template’s `/assets/img`), external media prefixes, and `site.cdn`. Confirm no double prefixing. Preserve external-prefix content and show the unsupported local-upload-destination state rather than silently changing it. Modify shared media handling only if needed to honor existing conventions, with regression fixtures.

Test foreign frames, stale generations, unregistered viewers, oversized messages, attempted other-workspace reads, and preview attempts to invoke authenticated APIs. Capture network requests to prove local bytes/URLs do not go to external image services. Run in Chromium, Firefox, and WebKit. Document exact viewer runtime deployment dependencies; a new editor cannot rely on bridge support absent from the served viewer.

**Gate:** The image works in the real nested-frame arrangement without relaxing the sandbox. If not, resolve transport here; do not ship a simple `<img>` proof as evidence for StoryKit viewer support.

### Save proof

Using a disposable initialized GitHub repository and the current OAuth service, commit Markdown, a generated manifest, and two images using the expected-head mutation. Demonstrate a competing commit, a competing change to the same image, a lost response, a protected-branch rejection, and the proposed maximum package payload. Verify a single new commit contains the intended bytes and unrelated files remain unchanged.

Measure Worker memory/CPU, encoding overhead, request/response limits, and maximum-image decoding validation. Finalize product limits and a supported server-side validation approach. If limits need lowering, update the spec and UI together. Do not solve a payload problem by splitting one logical save into partially visible file commits.

**Gate:** Prove the commit precondition and uncertain-result recovery with real GitHub evidence. Record any operation-metadata migration required; content bytes must not be stored in the service database.

## 3. M1 — Workspace storage, identity, and revisions

**Requirements:** LF-05–LF-07. **Depends on:** M0 path/limit decisions.

Add shared pure manifest/path/hash validation and an additive IndexedDB migration. Implement immutable bytes, mutable workspace manifests, package snapshots, pending-operation retention, garbage collection, cross-tab version checks, and digest-derived dirty state. Extend the existing forced-snapshot contract to text and asset versions together.

Create old-database fixtures containing drafts, revisions, caches, and bindings. Separate workspace UUID, filename-derived post ID, and explicit media directory in the model. Preserve existing prefixes on title/date/slug changes; test destination collisions for duplicate slugs and shared directories. Define one package-capture API for future preview/export/save callers; avoid separate snapshot implementations that can disagree on which image version belongs to the text.

**Gate:** Reload, upgrade interruption, quota failure, concurrent tabs, image-only replacement, revision restore, and garbage collection preserve the invariants. No UI or network capability is required to prove this milestone.

## 4. M2 — File ingestion and preview integration

**Requirements:** LF-01–LF-03, LF-08. **Depends on:** M0 and M1.

Implement Add files, drop/paste ingestion, file panel, insertion, replacement, missing-file repair, and removal semantics. Initialize new posts with the proposed conventional media prefix without rewriting existing drafts or the shared template implicitly. Add a parser-backed reference index limited to supported syntax. Connect current package resources to the preview and viewer bridge proven in M0. Keep legacy URL grammars and media behavior intact.

Use the existing editor bus/status surfaces; distinguish stored locally, not verified, missing, dirty, and remote state. Asset operations should not block typing. Perform expensive hash/decode work away from the interactive path, bounding concurrency and avoiding unnecessary copies of full-size images.

**Gate:** A signed-out author can import and view an image, replace it, reload, switch stories, restore the old image revision, and repair a missing supported path. Keyboard-only users can perform equivalent actions. Network assertions prove local ingestion/preview uploads nothing.

## 5. M3 — Portable package import/export

**Requirements:** LF-04, LF-12. **Depends on:** M1–M2.

Select a maintained ZIP library using the project’s dependency/pinning conventions. Implement bounded export/import, manifest discovery, copy collision behavior, byte hash checks, and transactional adoption. Keep Markdown import/export unchanged for users without managed files; clearly label omitted assets for Markdown-only export.

**Gate:** Export an unsynced story, import into a clean browser profile, and render the same source and image bytes. Verify archive extraction yields ordinary usable source paths. Reject malicious, corrupted, oversized, unsupported-version, and duplicate-path archives without modifying the active workspace. This provides a recovery path before package sync is enabled.

## 6. M4 — Multi-file GitHub save and pull

**Requirements:** LF-04, LF-09–LF-11. **Depends on:** M0–M3.

Add constrained workspace/asset/operation routes to the existing Worker and extend the editor adapter. Keep existing single-Markdown endpoints available; route a managed workspace through package synchronization. Add operation metadata/leases where needed. Locks should be scoped to the repository/branch operation across users, not only the current per-user save key; the GitHub expected-head precondition remains authoritative across external writers.

Implement per-path baseline comparison, manifest conflict handling, atomic save, image-only saves, snapshot adoption, source-preserving retries, no-change detection, and uncertain-result reconciliation. Handle authentication expiry, account switch, deleted branches, forbidden destinations, and rate limits explicitly.

Add fresh-browser open/pull of manifests and private image bytes at one commit. For unsupported/missing manifests, preserve Markdown access while preventing unsafe asset writes. Do not make asset fetch failures overwrite the local working copy.

**Gate:** A round trip through real GitHub and a clean browser produces the exact package. Conflicts preserve both recoverable versions. Inject failures before/after the remote mutation and after a newer local edit; the UI must neither duplicate commits blindly nor clear unsaved work.

## 7. M5 — Jekyll fidelity, compatibility, and release

**Requirements:** all. **Depends on:** M0–M4.

Build a representative saved/exported package through the repository’s actual Jekyll pipeline. Test image display and StoryKit interaction under root/project URLs and existing media/CDN configuration. Compare editor and built-site rendering, confirming there are no temporary URLs, missing assets, or accidental manifest outputs. Perform this as a test harness or disposable repository build; it does not require building the proposed hosted-preview product.

Run affected existing tests for editor persistence, media handling, GitHub opening/sync, login/isolation, preview interactions, accessibility, and render regression. Update user help, central-editor operating documentation, and the old editor spec’s now-superseded local-upload limitations.

Roll out server capabilities and backward-compatible viewer support before enabling the client feature. Advertise an explicit API/viewer capability version so mixed deployments fail with a useful message and preserve local data. Gate new ingestion on supported capabilities where needed; retain export/recovery when remote capabilities are unavailable.

Use the central editor’s staging deployment for final validation and a small pilot. A rollback must retain read/export access to new-format workspaces; do not blindly deploy a client that cannot read the upgraded IndexedDB schema. Package-sync failure can disable syncing while keeping local authoring and recovery available.

**Gate:** All release-blocking rows below pass, operating limits are documented from measurements, and an author outside the implementation team completes the end-to-end scenario without Git/file-path assistance. Only then treat this feature as a dependency available to publishing workflow development.

## 8. Proposed code boundaries

Names below are proposed, not existing files. Finalize exports after M0 and use injection seams consistent with current tests.

| Boundary | Responsibility |
| --- | --- |
| New `editor/workspace.js` | Workspace operations, immutable snapshot capture, package digest, lifecycle |
| New shared package-validation module | Versioned schemas, canonical paths, allowlists, bounds; usable in browser and Worker |
| `editor/store.js` | Database migration, bytes/manifests/revisions/operations, transactional version checks |
| New `editor/files.js` | Panel and ingestion orchestration; reused by `dnd.js`/picker/paste |
| New `editor/file-references.js` | Supported source parsing, canonical references, diagnostics, precise source edits |
| New `editor/preview-resources.js` | Resource assignment and bridge lifecycle, with `preview.js`/`context.js` |
| `assets/components/image.html` and shared component helpers | Backward-compatible editor-resource readiness/receive mode |
| New `editor/package-archive.js` | Bounded ZIP export/import; no auth or repository mutations |
| `editor/sync.js`, `github.js`, `conflict.js` | Package save/pull and conflict UI; keep Markdown-only behavior |
| `prototypes/github-auth/src/worker.js` plus extracted modules | Fixed GitHub operations, binary reads, package validation, operation reconciliation |
| `editor/app.js`, `doclist.js`, `statusbar.js`, help/styles | Integration and accessible state presentation |

Persisted format changes require migration tests; bridge changes require spoofing/isolation tests; sync changes require concurrency/failure tests. Avoid coupling file UI to publishing roles, PRs, or staging-repository assumptions.

## 9. Acceptance test matrix

All rows are release-blocking unless explicitly scoped to unsupported input behavior.

| ID / requirements | Scenario and observable result | Test level |
| --- | --- | --- |
| A01 / LF-01,05 | Add image signed out; close/reopen persistent profile; original file no longer available; preview still uses identical bytes | Browser e2e |
| A02 / LF-01,07 | Bad signature, animated format, oversized bytes/dimensions, mixed batch, clipboard/picker/drop; no silent partial insertion | Unit + browser + Worker |
| A03 / LF-02,05 | Replace image with unchanged prose; dirty state changes; restore revision recovers old bytes and source | Browser + storage |
| A04 / LF-03,06 | Filename-derived post ID, inline/reference Markdown, viewer src, custom/media/CDN prefixes; title/date/slug changes, shared directories and duplicate slugs; correct paths without double prefix or silent relocation | Parser unit + browser + Jekyll fixtures |
| A05 / LF-03,08 | Missing local replacement does not show previous remote image; unknown remote access is not marked missing | Browser |
| A06 / LF-05 | Upgrade old DB, quota failure, aborted transaction, old tab, concurrent replacement, active operation during GC; recoverable prior/current bytes remain | Storage + persistent-browser |
| A07 / LF-08 | Ordinary image and actual nested viewer work in flat/two-column mode; zoom/action links/scroll sync remain correct | Three-engine browser e2e |
| A08 / LF-08 | Wrong window/generation/resource, malicious frame, other-document request; no bytes/authority leak; local resource never goes to CDN transformer | Browser security + network interception |
| A09 / LF-12 | ZIP export/import into clean profile preserves byte hashes and source; omission notices and copy identity behave correctly | Archive unit + browser |
| A10 / LF-06,12 | Traversal, symlink, zip bomb, duplicate/case path, corrupt hashes, malformed manifest, unsupported schema; no partial adoption or remote write authority | Archive + Worker |
| A11 / LF-09,10 | One save adds text+manifest+two images in one commit; unrelated tree entries preserved; no-change save produces no commit | Worker mock + real GitHub |
| A12 / LF-10 | Remote same-path edit versus unrelated edit; competing commit during mutation; only unrelated changes reconcile automatically | Stateful mock + real race |
| A13 / LF-05,10 | Type/replace during save; captured package saves correctly and newer local revision stays dirty | Browser e2e |
| A14 / LF-11 | Lose response before/after commit; retry operation; advance remote again; no duplicate or false synchronized state | Worker + browser fault injection |
| A15 / LF-09,11 | Fresh browser private repo load, login expiry/account switch, partial pull, deleted branch, protected branch; local data preserved, credentials absent from URLs/logs | Integrated login e2e |
| A16 / LF-02,06 | Referenced local removal blocked; unreferenced managed removal leaves committed remote file; collision requires choice | Browser + tree assertion |
| A17 / LF-06,08 | Saved and extracted ZIP content renders in real Jekyll root/project sites, including media/CDN cases; no editor-only URLs | Jekyll + rendered interaction |
| A18 / LF-02,07 | Keyboard/screen-reader flow and maximum supported package; typing remains usable, memory bounded, resources cleaned up | Accessibility + performance |
| A19 / LF-04,05 | Legacy Markdown-only saves/import/export, drafts, revisions, bookmarklets, viewer resources, auth all retain behavior | Existing regression suites |
| A20 / LF-09 | Forged operation, arbitrary GraphQL/path, credential misuse, oversize streaming input, malformed manifest/asset; service rejects within bounds | Worker security tests |

Use deterministic small raster fixtures with known hashes and visually distinct replacement images. Generate boundary fixtures rather than committing large binaries. Simulate network failures and GitHub races using the existing stateful mocks; keep a smaller disposable-repository suite to validate real semantics. Never use author repositories for destructive race fixtures.

## 10. Validation commands and evidence

Extend existing runners rather than introduce a competing framework. Candidate commands from the repository root, using its configured runtimes:

```sh
npm test --prefix prototypes/github-auth
python tools/run_browser_tests.py
python tools/render_regression.py --check
python tools/check_viewer_catalog.py
python tools/check_editor_pins.py
python -m pytest tests/e2e/ -v
python -m pytest prototypes/github-auth/tests/test_browser.py -v
bundle exec jekyll build
```

The current browser suites need explicit Firefox/WebKit coverage for the new bridge scenarios; do not assume the existing Chromium suite proves portability. Add new focused modules/tests beside the established suites and run the affected subset during each milestone. Run the full required editor checks once the integrated feature is ready.

Each milestone records changed interfaces, tests/results, known limitations, and fixtures. M0 records payload/runtime measurements and the resource transport decision. M5 records a real commit link, resulting file hashes, representative preview/Jekyll captures, recovery evidence, and capability/rollback instructions. These are future implementation deliverables; this planning task has not run or passed those tests.

## 11. Decisions and finish line

Proceed with the proposed defaults: raster images first, browser-local ownership before explicit upload, a portable manifest, expected-head package commits, and ZIP recovery. M0 settles transport details, syntax compatibility, validation tooling, and actual limits. These are bounded engineering decisions, not reasons to reopen the publishing architecture.

The feature is finished when a non-technical author can complete the workflow with two images, recover older media, move to a second browser, and produce working Jekyll output while all A01–A20 checks pass. Larger files, additional resource types/viewers, and repository-wide cleanup become follow-up work. The publishing platform may then consume the established package snapshot, manifest, and commit identity instead of inventing another file model.

## 8. Authorized data-file extension (September 7, 2026)

1. Resolve the configured-layout image initialization regression and retain tests for hosts present and absent across Chromium, Firefox, and WebKit.
2. Extend shared browser/service validation, manifest metadata, ingestion, replacement, archive, copy, and pinned GitHub reads to JSON, GeoJSON, CSV, TSV, and TXT. Preserve existing limits and exact bytes; add `localData: 1` capability gating.
3. Track Markdown file links and individual literal map GeoJSON layers. Add portable insertion and opaque local downloads; extend explicit viewer assignments to maps without exposing editor storage or credentials. Fit unspecified map views to their GeoJSON extent.
4. Prove all file types survive storage/archive/save/read, malformed files cannot mutate packages, multiple local map layers render after reload, and image expansion remains functional. Verify download bytes and absence of remote local-file fetches. Run existing unit, service, transport, and Jekyll checks.
5. Update author help and deploy the tested build to staging. Production promotion and publishing-platform work remain separate.
