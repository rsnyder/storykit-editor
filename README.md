# StoryKit Editor

Browser-based StoryKit authoring, live preview, local story packages, and GitHub sync.
Production: https://storykit-editor.ron-f9a.workers.dev/editor/

## Development

```sh
node tools/prepare-framework.mjs
npm ci --prefix prototypes/github-auth
npm test --prefix prototypes/github-auth
node prototypes/github-auth/tools/build-editor.mjs
```

See [the authentication service guide](prototypes/github-auth/README.md) for local
configuration and Worker deployment. Credentials and Worker state are never source files.

`editor/` owns the application; `assets/js/skrender.js` owns the client-side renderer.
The publishing runtime belongs to [storykit-starter](https://github.com/rsnyder/storykit-starter).
The versioned `tests/fixtures/starter/` snapshot supplies viewer assets, Liquid templates,
and Jekyll integration fixtures. Preparation materializes it into ignored root paths;
the production asset build runs preparation automatically. Update the snapshot and
its `SOURCE.json` together when adopting starter changes. The initial snapshot records
the source commit and includes the local framework edits present during extraction.

## Verification

After preparation, run `bundle install` and `bundle exec jekyll build`.
Install Python `pytest` and `playwright`, then `playwright install`.
Run `python tools/check_viewer_catalog.py`, `python tools/check_editor_pins.py`,
`python tools/run_browser_tests.py`, `python tools/render_regression.py --check --target editor`,
and `python -m pytest tests/e2e/`, then separately
`python -m pytest prototypes/github-auth/tests/test_browser.py`.
CI runs these independently of a starter checkout. The editor owns `tests/render/editor-golden/`; review changes before updating it with
`python tools/render_regression.py --capture`. The initial editor baseline includes
the pinned Chirpy `cors.yml` resource hints and stylesheets, previously missing from
the fixtures. Historical rendering goldens retain
the original starter guide content as fixtures.

## Existing address and draft recovery

Production editor: https://storykit-editor.ron-f9a.workers.dev/editor/

This repository publishes a transition page at the former GitHub Pages address.
It preserves `open`, `repo`, and `branch` bookmarklet parameters in the production
link. A pinned copy of the previous editor at `legacy/` retains access to browser
storage on the old origin for export and recovery. Production authentication and
editor assets are served together by the Cloudflare Worker, maintained in
this repository under `editor/` and `prototypes/github-auth/`.
