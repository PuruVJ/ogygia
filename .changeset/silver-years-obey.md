---
"ogygia": minor
---

**Breaking:** features move into plugin packages listed once in `ogygia({ plugins: [...] })`: flags (`@ogygia/flags`, was `ogygia/flag`), frozen pages (`@ogygia/freeze`, was `ogygia/freeze` and `ogygia({ freeze })`) and fragment federation (`@ogygia/federation`, was `ogygia/federation`; `mount` moved from `ogygia/router`) and content (`@ogygia/content`, was `ogygia/content*` and `ogygia({ content })`; `ogygia/content/server` is `@ogygia/content/remote`, and the svelte config's `ogygia.preprocess()` / `ogygia.extensions()` are `preprocess()` / `extensions()` from `@ogygia/content/vite`), each with its factory from `<package>/vite`.
