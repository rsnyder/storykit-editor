# StoryKit editor address and local draft recovery

Production editor: https://storykit-editor.ron-f9a.workers.dev/editor/

This repository publishes a transition page at the former GitHub Pages address.
It preserves `open`, `repo`, and `branch` bookmarklet parameters in the production
link. A pinned copy of the previous editor at `legacy/` retains access to browser
storage on the old origin for export and recovery. Production authentication and
editor assets are served together by the Cloudflare Worker, maintained in
`rsnyder/storykit-starter` under `editor/` and `prototypes/github-auth/`.
