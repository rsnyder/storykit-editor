# StoryKit editor — central deployment

**Live at https://rsnyder.github.io/storykit-editor/**

This is a deploy-only repository: the editor is developed, tested and
golden-gated in [rsnyder/storykit-starter](https://github.com/rsnyder/storykit-starter)
(`editor/` + `assets/js/skrender.js`). The `deploy` workflow here checks out
the canonical source and publishes it to Pages — on manual dispatch
(`gh workflow run deploy -R rsnyder/storykit-editor`), on a daily cron, and
on pushes to this repo.

Architecture and asset-origin policy: `docs/editor-central.md` in the
canonical repo.
