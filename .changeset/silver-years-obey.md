---
"ogygia": minor
---

**Breaking:** features move into plugin packages listed once in `ogygia({ plugins: [...] })`: flags (`@ogygia/flags`, was `ogygia/flag`) and frozen pages (`@ogygia/freeze`, was `ogygia/freeze` and `ogygia({ freeze })`), each with its factory from `<package>/vite`.
