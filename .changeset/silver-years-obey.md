---
"ogygia": minor
---

**Breaking:** features move into plugin packages listed once in `ogygia({ plugins: [...] })`: flags (`@ogygia/flags`, was `ogygia/flag`), frozen pages (`@ogygia/freeze`, was `ogygia/freeze` and `ogygia({ freeze })`) and fragment federation (`@ogygia/federation`, was `ogygia/federation`; `mount` moved from `ogygia/router`), each with its factory from `<package>/vite`.
