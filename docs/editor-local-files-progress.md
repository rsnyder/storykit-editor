> Repository migration (2026-09-10): editor source, service, and tests now live in `rsnyder/storykit-editor`. Earlier source-location and standalone-preview references below are historical. See the root README for current build and test instructions.

# Local files implementation and validation

Implementation is available in the working tree and central-editor staging. Production promotion and the independent author pilot from M5 remain release gates; the canonical viewer runtime has not been deployed by this task.

## Implemented behavior

- Signed-out JPEG, PNG and static WebP picker/drop/paste; a keyboard-accessible Story files panel with insertion, replacement, description, removal, repair and download.
- IndexedDB v2 stores immutable typed bytes by SHA-256. Typed bytes avoid a WebKit Blob-storage failure observed in the three-engine test. Package mutations and forced revisions share a transaction; version checks reject stale operations. Upgrades wait for old tabs, with a persistent explanation. Pending operations retain their bytes during garbage collection.
- A package captures source, manifest and immutable image versions. Image-only edits change its dirty state. History restores source and image versions together. Legacy text-only history retains current files for recovery with an explanation.
- New posts use the filename-derived `/assets/posts/<slug>` convention; existing local prefixes are preserved. Copies receive new workspace IDs and destinations and are unbound. Imported Markdown can acquire a conventional post path when files are first added.
- Lezer indexes inline/reference Markdown images and literal image-viewer sources, excluding code. Unsupported/dynamic syntax is not checked; unmanaged repository paths are not incorrectly labeled missing. Only recognized destinations are rewritten for previews or copies.
- Opaque preview transport assigns resources to exact windows, generations and IDs. Ordinary images and nested viewers create their own object URLs. Expanded/column-mode viewers retain the assignment. Local resources bypass external image transformers. Source and exported files never contain temporary URLs.
- ZIP import validates paths, modes, duplicates, counts, expansion bounds, version and decoded image hashes before a single adoption transaction. ZIP export includes ordinary Markdown, owned files and `_data/storykit_workspaces/<id>.json`. Markdown-only export explains that images are omitted.
- Authenticated package reads pin all files to one commit. Explicit saves use one `createCommitOnBranch` mutation with `expectedHeadOid`, per-path baselines and a repository/branch lease. Other workspace manifests are checked for conflicting ownership. Remote files removed from the local manifest are retained in GitHub.
- Durable operation IDs record only account/destination, package digest and Git identities in D1. An uncertain save is reconciled by marker **and** verified path/blob identities; an ancestor success is not labeled the latest remote state. Newer local edits remain dirty after a captured save.
- Package conflicts offer Keep local, Use remote, Keep both and Cancel, with links to the exact remote commit for comparison. Partial pulls preserve the local working copy. Unsupported/unavailable packages still open Markdown for recovery with package writes disabled. Legacy single-file endpoints refuse to detach a managed workspace.

## Supported limits and decoder measurements

| Limit | Implemented value |
| --- | --- |
| Image bytes | 5 MiB per file |
| Image dimensions | 4 megapixels |
| Package images | 50 files, 8 MiB total |
| Markdown | 200,000 UTF-8 bytes |
| Manifest | 256 KiB |
| Save request | 12 MiB |
| ZIP | 10 MiB compressed, 9 MiB expanded, 64 entries |

`tools/prove-raster.mjs` runs the production decoders in workerd, including compiled WebP WASM. Representative 4 MP solid-image PNG/JPEG validation took approximately 76/97 ms locally; 4 MP WebP also passed. These are local elapsed-time observations, not hosted CPU or peak-memory measurements. The proposed 24 MP JPEG exceeded the decoder's 100 MB allocation budget, and 24 MP RGBA PNG exceeded the bounded PNG budget. The spec and UI were lowered together.

PNG validation checks original CRCs, bounds IDAT expansion and discards optional metadata **only in the validation copy**, avoiding compressed-profile/text decompression channels. Original bytes remain unchanged. Large base64 decoding uses a bounded typed-array loop; the maximum-size live pull exposed an excessive temporary allocation in `Uint8Array.from(string, mapper)`, which was removed.

## Real GitHub and OAuth evidence

The user designated `rsnyder/storykit-editor-local-files` for disposable tests. All test writes use dedicated `codex/` branches.

- [Atomic source/manifest/two-image proof](https://github.com/rsnyder/storykit-editor-local-files/commit/7df731a3f7647ee24a7443b5a51d6173089e8226): exactly four paths in one commit. Same-image race rejected; a deliberately lost response reconciled after another commit advanced the branch.
- [8 MiB primitive payload](https://github.com/rsnyder/storykit-editor-local-files/commit/6a40c1036c0c050da486fc042012f33c5d0678ab): image bytes verified through Git blob reads. The new proof branch was then protected; its next write was rejected without changing the head. Protection remains on that disposable branch.
- [Real staging OAuth package commit](https://github.com/rsnyder/storykit-editor-local-files/commit/82a79e39e9cbf5b826533bbdec2200656250ea0d): source, manifest and **two 4 MiB PNGs** saved in one commit on `codex/local-files-oauth-proof`. The browser reported Synced. A subsequent authenticated pull decoded and verified both images, and the recovered Markdown image rendered from a local object URL.

| OAuth image | SHA-256 |
| --- | --- |
| `storykit-red.png` | `eee3ada12f0da5065473530083717865afb99cd2dccdcbcac1c55bb16d63f96f` |
| `storykit-blue.png` | `56ef678aa6da93d97b26811d727764817b34c7769e2458592da211547648f31a` |

The images contain inert PNG ancillary padding to exercise byte limits without checking large binary fixtures into this repository. Their Git blob IDs were independently compared against the original files using `gh`; no token was extracted or logged.

## Automated verification

Final checks on 2026-09-07 passed: 480 browser unit tests, 81 editor end-to-end tests (including the three-engine local-file suites), 41 Worker tests, 11 authentication browser tests, 13 render goldens and 24 production Jekyll cases. Import-map pins, viewer catalog and `git diff --check` also passed. The final staging deployment is version `4064bbb4-841b-4ffd-b952-bc9d94dd4dd4`.

The checked-in suites cover signed-out import/reload across Chromium, Firefox and WebKit, nested viewer transport/zoom/expansion/column switching, spoofed messages, stale generation/window/resource rejection, immutable replacement and restore, stale text/package writes, pending-operation retention, portable ZIP recovery and hostile archives, authenticated atomic commits, no-change saves, rejected protection, uncertain recovery, ownership checks, and edits made while a save is in flight.

`tools/prove_local_media.rb` runs six actual production Jekyll builds: root/project URLs crossed with empty, conventional and Cloudinary CDN settings. Its 24 cases cover conventional/custom/external media prefixes and explicit root-relative paths. It verifies Markdown/viewer destinations, unchanged PNG bytes and no public workspace-manifest output. Existing media behavior and all 13 render goldens remain covered by regression checks.

## Rollout and remaining release gates

1. Apply `0003_workspace_operations.sql` before deploying the package-capable Worker. This additive migration and the Worker are deployed to **staging**; production was not changed.
2. Deploy `assets/components/image.html`, `assets/js/storykit-local-image.js` and `assets/js/storykit.js` together at the canonical runtime origin. The protocol version is 1. Until that runtime is updated, ordinary local Markdown images work, and old nested viewers display an update explanation instead of silently implying success. Local storage and package export remain available.
3. Promote only after the M5 independent-author pilot and hosted performance review. The live OAuth proof uses the designated public test repository. The pilot still needs a clean private-repository profile and hosted peak-memory/CPU review; controlled service tests do not substitute for those live checks.
4. Rollback must preserve the v2 database reader and package export. Do not roll back to a client that only opens IndexedDB v1. Package synchronization can be disabled without discarding local bytes or revisions. Do not delete the D1 operation table while uncertain attempts exist.

## Staging preview repair (2026-09-07)

A user check exposed an unstyled full-page preview in the disposable repository. Its configuration has no public site URL, so compiled Chirpy CSS was incorrectly requested from the central editor host. Context now selects the canonical compiled theme for this case, limits the fallback to theme CSS/runtime assets, preserves content and custom-asset destinations, and explains the fallback in preview diagnostics. Configured sites retain their theme origin. The fix passed 482 browser unit tests and was deployed as staging version `b700cb94-2d3d-4a87-8ea6-52150dda37c4`; a visual browser check confirmed styled rendering and usable Edit/Split/Story files controls.

## Staging viewer repair (2026-09-07)

The user’s `Macaws.jpg` image tag exposed missing StoryKit includes in the plain disposable test repository. Central staging now bundles an allowlisted set of public viewer includes and uses them when the repository/gem resolution returns no template. Per-site editors can use the starter fallback. Local image frames use the component shipped alongside the editor, independent of canonical runtime promotion. The public image component (including Cloudflare’s extensionless redirect) permits sandboxed framing; only public JS assets allow cross-origin module reads. Editor and API framing protections remain. Publishing viewer tags still requires StoryKit in the destination repository.

Verified 483 browser unit tests, 42 Worker tests and all five integrated local-file tests, including Chromium/Firefox/WebKit. The fixture server now matches the deployed public-module CORS headers. Deployed staging version `38a73150-afbe-4d16-b643-cff3a8741fd2`. A browser screenshot confirmed the user’s actual Macaws image and “Local Image” caption render without changing their Markdown or uploading the image. This supersedes the earlier canonical-runtime dependency for local image previews; canonical runtime promotion remains relevant to published sites.

## Local cover images (2026-09-07)

Added literal front-matter `image.path` and scalar `image` shorthand to the shared reference index using the already-pinned YAML parser. Block and flow mappings and quoted paths use exact syntax offsets. Preview replacement and duplicate-path rewriting emit safe YAML strings and leave comments, alternative text, unrelated fields and prose intact. Covers participate in file-use/removal checks, local byte transport and existing package recovery. External paths keep their existing behavior; aliases and nonliteral expressions are not checked. The spec and editor help now document the extension.

Validation: 484 browser unit tests and five integrated local-file tests passed, including cover-plus-viewer rendering after reload in Chromium, Firefox and WebKit. Staging deployment: `f09504b2-4bde-43fe-b7ae-81b0871ed27d`.

## PHL preview configuration repair (2026-09-07)

PHL’s repeated `avatar` configuration key caused js-yaml to reject the entire configuration, discarding its URL and theme and generating an invalid stylesheet destination. Configuration parsing now matches Jekyll/Psych last-key-wins behavior (confirmed with the actual public PHL config). Corrected Chirpy origin metadata from the nonexistent `default.yml` to `cors.yml`, with `basic.yml` for self-hosted assets. Verified 485 browser unit tests and four preview end-to-end regressions. Staging version `56253566-4480-450b-bee1-c7f527f9b08a`. The St. John’s wort published page was used to compare expected CSS links; the remaining live Olive essay tab visually confirmed PHL CSS, fonts and image/text layout restored. No PHL repository content was changed.

## Local-image expansion (2026-09-07)

The plain test repository rendered the local component without a StoryKit host module, so expand requests had no dialog listener. Local-viewer previews now load the bundled host when none is present, plus the dialog theme; existing host initialization is preserved. The resource broker accepts the exact extensionless alias on the assigned runtime origin, covering Cloudflare’s `image.html` → `image` redirect when a dialog reuses the component’s final URL. The caption’s Open fullscreen button now invokes the same action as clicking the image.

Validation: 485 browser unit tests, 12 existing runtime transport tests, and five integrated local-file tests passed. The integrated expansion case explicitly disables layout-provided StoryKit initialization to exercise the reported missing-host path, follows a real HTTP redirect in the fixture server, and checks image click, dialog close, keyboard fullscreen activation, and expanded canvas rendering in all three engines. Staging version `cf0f4d41-37b8-4c30-b9f3-dd05f2dad9fb`. Browser automation could inspect the live Macaws viewer but could not reliably activate its nested control; live visual confirmation of the expanded dialog remains part of author checkout.

Additional release follow-up: the integrated fixture variant with its existing layout initializer showed a viewer-load timeout even with the new runtime-injection block disabled. That broader initialization/restructuring case needs investigation; the direct runtime transport suite still passes. It is not covered by the successful missing-host expansion claim above.

## Data and text extension (2026-09-07)

Implemented JSON, GeoJSON, CSV, TSV, and TXT in the same local workspace, history, archive, and explicit GitHub save/pinned-read pipeline. Limits remain 50 files, 5 MiB/file, and 8 MiB total; dimension limits apply only to images. Shared validation derives MIME from an allowlisted filename, preserves exact UTF-8 bytes/line endings, rejects invalid encodings and binary controls, bounds JSON complexity, and checks GeoJSON geometry/feature structure. Empty text/delimited files are supported. Schema-1 data entries omit dimensions, and `localData: 1` gates remote data saves.

The picker accepts the new extensions. GeoJSON insertion creates a map; data/text insertions create literal Jekyll `relative_url` Markdown download links. The reference index tracks those links and individual map GeoJSON layers, preserving labels and external layers during preview and copy. Local maps receive only explicitly assigned resources via the opaque bridge; multiple layers and expanded maps retain those assignments. Unspecified GeoJSON map views fit their geometry bounds in both the editor and published runtime. Other component inputs and local URLs inside data remain outside this extension.

The earlier configured-layout image timeout is resolved: revealing a decoded image no longer waits for animation frames that the host layout can suspend. Local previews now use the editor's shipped StoryKit host module while preserving publication initializer options. This closes the older-publication-runtime expansion gap. The public image and map CSPs explicitly allow their own public JS directory because WebKit treats `'self'` as the sandbox's opaque origin. Neither viewer receives same-origin editor access. The outer preview allows explicit file downloads. The image fullscreen control also has a visible icon and fixed hit target above the aspect-ratio tooltip hotspot.

Validation before final staging smoke: 489 browser unit tests, 44 service tests, 27 integrated preview/transport/M3 tests, and 24 actual Jekyll path cases passed. Added exact-byte round trips for every format, malformed-data rejection before remote mutation, multi-layer maps after reload, expanded maps, CSV downloads, mixed-image/data save races, and an obsolete-publication-runtime fixture. Eleven tests against that obsolete runtime passed across Chromium/Firefox/WebKit. The lazy-viewer fixture now waits for the cover image to decode before scrolling, avoiding a layout shift above the target. The following 11-case local-file run and six mouse/keyboard fullscreen cases passed. Final deployment/smoke results are recorded below.

First staging deployment for this extension: `c8d27ad2-3588-477f-91a2-6be13e93ab5b`. The live smoke exposed the invisible zero-width fullscreen control; the final staging update includes its correction. Production deployment and the private-profile/hosted-performance release gates remain separate.

Final staging version: `693aaa19-8992-4b0b-8e6a-488ce69010a5`. Live checks used clean, disposable Chromium, Firefox, and WebKit contexts against the actual deployed editor and live publication assets, without substituting viewer or host modules. All three rendered local images and GeoJSON, opened both expanded viewers, and downloaded CSV with byte-for-byte CRLF preservation. Chromium/Firefox reported no page errors; WebKit logged blocked cross-frame-access attempts consistent with the retained opaque sandbox, while every functional assertion passed. The public capability endpoint advertises `{workspace: 1, localImage: 1, localData: 1}`. No user draft or production repository was modified by these smoke checks.
